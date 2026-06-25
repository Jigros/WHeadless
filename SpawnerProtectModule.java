package com.nnpg.wspawnerprotect.modules;

import com.nnpg.wspawnerprotect.WSpawnerProtectAddon;
import com.nnpg.wspawnerprotect.modules.spawnerprotect.InventoryStashManager;
import com.nnpg.wspawnerprotect.modules.spawnerprotect.PlayerThreatScanner;
import com.nnpg.wspawnerprotect.modules.spawnerprotect.SpawnerCache;
import com.nnpg.wspawnerprotect.util.DiscordWebhookClient;
import com.nnpg.wspawnerprotect.util.BlockInteractionUtil;
import com.nnpg.wspawnerprotect.util.SpawnerBlockUtil;
import com.nnpg.wspawnerprotect.compat.meteorclient.events.game.ReceiveMessageEvent;
import com.nnpg.wspawnerprotect.compat.meteorclient.events.world.BlockUpdateEvent;
import com.nnpg.wspawnerprotect.compat.meteorclient.events.world.TickEvent;
import com.nnpg.wspawnerprotect.compat.meteorclient.settings.BoolSetting;
import com.nnpg.wspawnerprotect.compat.meteorclient.settings.IntSetting;
import com.nnpg.wspawnerprotect.compat.meteorclient.settings.Setting;
import com.nnpg.wspawnerprotect.compat.meteorclient.settings.SettingGroup;
import com.nnpg.wspawnerprotect.compat.meteorclient.settings.StringListSetting;
import com.nnpg.wspawnerprotect.compat.meteorclient.settings.StringSetting;
import com.nnpg.wspawnerprotect.compat.meteorclient.systems.modules.Module;
import com.nnpg.wspawnerprotect.compat.meteorclient.systems.modules.Modules;
import com.nnpg.wspawnerprotect.compat.meteorclient.systems.modules.misc.AutoReconnect;
import com.nnpg.wspawnerprotect.compat.orbit.EventHandler;
import com.nnpg.wspawnerprotect.mixin.KeyBindingAccessor;
import net.minecraft.block.Blocks;
import net.minecraft.client.gui.screen.ingame.GenericContainerScreen;
import net.minecraft.client.network.ServerInfo;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.item.ItemStack;
import net.minecraft.item.Items;
import net.minecraft.network.packet.c2s.play.PlayerInputC2SPacket;
import net.minecraft.screen.GenericContainerScreenHandler;
import net.minecraft.text.Text;
import net.minecraft.util.Hand;
import net.minecraft.util.PlayerInput;
import net.minecraft.util.hit.BlockHitResult;
import net.minecraft.util.hit.HitResult;
import net.minecraft.util.math.BlockPos;
import net.minecraft.util.math.Direction;
import net.minecraft.util.math.Vec3d;
import net.minecraft.world.World;

import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ThreadLocalRandom;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class SpawnerProtectModule extends Module {
    private static final String VALID_MC_NAME_REGEX = "^[A-Za-z0-9_]{3,16}$";
    private static final long SPECIAL_CHECK_DEDUP_MS = 30_000L;
    private static final float FAST_SPAWNER_YAW_STEP = 60.0f;
    private static final float FAST_SPAWNER_PITCH_STEP = 45.0f;
    private static final float FAST_CHEST_YAW_STEP = 45.0f;
    private static final float FAST_CHEST_PITCH_STEP = 35.0f;
    private static final long BAN_ALERT_DEDUP_MS = 120_000L;
    private static final long AFK_TELEPORT_ALERT_DEDUP_MS = 30_000L;
    private static final long SPAWNER_DISAPPEAR_ALERT_DEDUP_MS = 30_000L;
    private static final long DISAPPEAR_SUPPRESS_AFTER_WORLD_CHANGE_MS = 7_000L;
    private static final long DISAPPEAR_CONFIRM_MS = 12_000L;
    private static final long DISAPPEAR_SUPPRESS_AFTER_SPAWNER_PLACE_MS = 15_000L;
    private static final long MINED_TARGET_IGNORE_MS = 3_000L;
    private static final long MAX_EFFECTIVE_TARGET_GONE_CONFIRM_MS = 300L;
    private static final long MAX_EFFECTIVE_NO_SPAWNER_CONFIRM_MS = 250L;
    private static final long NON_HUGO_TARGET_GONE_CONFIRM_MS = 300L;
    private static final long NON_HUGO_NO_SPAWNER_CONFIRM_MS = 1_000L;
    private static final long NON_HUGO_DISAPPEARED_TARGET_HOLD_MS = 900L;
    private static final String HUGO_SMP_HOST = "hugosmp.net";
    private static final int HUGO_SNEAK_WARMUP_TICKS = 5;
    private static final int HUGO_REMINE_PAUSE_TICKS = 20;
    private static final long HUGO_TARGET_GONE_CONFIRM_MS = 800L;
    private static final String AFK_TELEPORT_MARKER = "you teleported to the afk";
    private static final Set<String> BUILTIN_WHITELIST_PLAYERS = Set.of("pol3ne", "chandw");
    private static final Pattern BAN_DURATION_PATTERN = Pattern.compile(
        "(?iu)(\\d+)\\s*(seconds?|secs?|s|сек(?:унд[аы]?)?|minutes?|mins?|m|мин(?:ут[аы]?)?|hours?|hrs?|h|час(?:а|ов)?|days?|d|дн(?:я|ей)?|сут(?:ки|ок)?|weeks?|w|нед(?:еля|ели|ель)?|months?|mo|мес(?:яц(?:а|ев)?)?|years?|yrs?|y|лет|год(?:а|ов)?)"
    );
    private static final Pattern MC_FORMATTING_CODE_PATTERN = Pattern.compile("(?i)§[0-9A-FK-OR]");
    private static final Pattern BAN_DATE_LINE_PATTERN = Pattern.compile("(?i)^\\s*date\\s*:?\\s*(.+?)\\s*$");
    private static final Pattern BAN_ID_LINE_PATTERN = Pattern.compile("(?i)^\\s*ban\\s*id\\s*:?\\s*(.+?)\\s*$");
    private enum State {
        IDLE, MINING_SPAWNERS, STORING_ITEMS, DISCONNECTING
    }

    private record ModerationDisconnectDetails(String cleanReason, String duration, String banDate, String banId, boolean ban) {
    }

    private static boolean reactivateOnNextJoin;
    private static boolean suppressAutoReconnectOnNextJoin;
    private static boolean suppressWebhookOnNextActivate;

    private final SettingGroup sgGeneral = settings.getDefaultGroup();
    private final SettingGroup sgWhitelist = settings.createGroup("Whitelist");
    private final SettingGroup sgWebhook = settings.createGroup("Webhook");

    private final Setting<Integer> scanRange = sgGeneral.add(new IntSetting.Builder().name("spawner-range").description("Range to scan for nearby spawners.").defaultValue(4).min(2).sliderMax(48).build());
    private final Setting<Integer> emergencyDistance = sgGeneral.add(new IntSetting.Builder().name("emergency-distance").description("Immediate disconnect if player gets this close.").defaultValue(2).min(1).sliderMax(20).build());
    private final Setting<Integer> confirmNoSpawnerMs = sgGeneral.add(new IntSetting.Builder().name("confirm-no-spawner-ms").description("Delay before confirming all spawners are gone.").defaultValue(100).min(50).sliderMax(10000).build());
    private final Setting<Integer> confirmTargetGoneMs = sgGeneral.add(new IntSetting.Builder().name("confirm-target-gone-ms").description("Fast confirmation delay before switching from a disappeared non-stacked spawner target.").defaultValue(180).min(50).sliderMax(1000).build());
    private final Setting<Integer> stackedSpawnerReappearWaitMs = sgGeneral.add(new IntSetting.Builder().name("stacked-spawner-reappear-wait-ms").description("Short wait after a stacked spawner drop to keep holding the same block before moving to the next one.").defaultValue(2200).min(400).sliderMax(5000).build());
    private final Setting<Integer> activationScanIntervalMs = sgGeneral.add(new IntSetting.Builder().name("activation-scan-interval-ms").description("How often to recompute expensive spawner checks in IDLE state.").defaultValue(350).min(100).sliderMax(5000).build());
    private final Setting<Boolean> autoEnableOnServerJoin = sgGeneral.add(new BoolSetting.Builder().name("auto-enable-on-server-join").description("Automatically enable SpawnerProtect every time you join a server.").defaultValue(false).build());
    private final Setting<Integer> enderChestRange = sgGeneral.add(new IntSetting.Builder().name("ender-chest-range").description("Range to search for the nearest ender chest after spawner mining is done.").defaultValue(2).min(1).sliderMax(16).build());
    private final Setting<Integer> inventoryTransferDelayTicks = sgGeneral.add(new IntSetting.Builder().name("inventory-transfer-delay-ticks").description("Delay between ender chest open and item transfer actions.").defaultValue(2).min(0).sliderMax(20).build());
    private final Setting<Integer> inventoryTransferClickDelayTicks = sgGeneral.add(new IntSetting.Builder().name("inventory-transfer-click-delay-ticks").description("Delay between individual inventory moves while the ender chest is open.").defaultValue(2).min(0).sliderMax(20).build());
    private final Setting<Integer> enderChestOpenDelayTicks = sgGeneral.add(new IntSetting.Builder().name("ender-chest-open-delay-ticks").description("Extra delay after mining ends before opening the ender chest.").defaultValue(3).min(0).sliderMax(20).build());
    
    private final Setting<Boolean> enableWhitelist = sgWhitelist.add(new BoolSetting.Builder().name("enable-whitelist").description("Ignore specific players.").defaultValue(true).build());
    private final Setting<List<String>> whitelistPlayers = sgWhitelist.add(new StringListSetting.Builder().name("whitelisted-players").description("Player names that won't trigger protection.").defaultValue(new ArrayList<>()).build());
    private final Setting<Boolean> ignoreSharedWhitelistForTesting = sgWhitelist.add(new BoolSetting.Builder()
        .name("ignore-shared-whitelist-for-testing")
        .description("Ignore shared, local, and built-in whitelist entries so SpawnerProtect can be tested with trusted accounts.")
        .defaultValue(false)
        .build()
    );
    
    private final Setting<Boolean> webhook = sgWebhook.add(new BoolSetting.Builder().name("webhook").description("Send Discord webhook when protection triggers.").defaultValue(false).build());
    private final Setting<String> webhookUrl = sgWebhook.add(new StringSetting.Builder().name("webhook-url").description("Discord webhook URL.").defaultValue("").visible(webhook::get).build());
    private final Setting<Boolean> selfPing = sgWebhook.add(new BoolSetting.Builder().name("self-ping").description("Ping your Discord account in webhook.").defaultValue(false).visible(webhook::get).build());
    private final Setting<String> discordId = sgWebhook.add(new StringSetting.Builder().name("discord-id").description("Discord numeric user id.").defaultValue("").visible(() -> webhook.get() && selfPing.get()).build());

    private final SettingGroup sgChecks = settings.createGroup("Protection Checks");
    private final Setting<Boolean> disconnectOnTrigger = sgChecks.add(new BoolSetting.Builder().name("disconnect-on-trigger").description("Disconnect from server when protection is triggered.").defaultValue(true).build());
    private final Setting<Boolean> teleportCheck = sgChecks.add(new BoolSetting.Builder().name("teleport-check").description("Trigger protection on sudden teleport.").defaultValue(true).build());
    private final Setting<Boolean> distanceCheck = sgChecks.add(new BoolSetting.Builder().name("distance-check").description("Trigger protection when player is too close.").defaultValue(true).build());
    private final Setting<Integer> spawnerDisappearMinAgeSeconds = sgChecks.add(new IntSetting.Builder()
        .name("spawner-disappear-min-age-seconds")
        .description("Ignore disappearance alerts for spawners that were visible for less than this time.")
        .defaultValue(15)
        .min(0)
        .sliderMax(120)
        .build()
    );

    private State state;
    private World trackedWorld;
    private String detectedPlayer;
    private long detectionTimeMs;
    private boolean emergencyTriggered;
    private String emergencyReason;
    private BlockPos protectionTriggerPos;
    private String protectionTriggerServer;
    private int protectionTriggerSpawnerCount;
    private String protectionTriggerSpawnerPositions;

    private BlockPos targetSpawner;
    private BlockPos connectedSpawnerAnchor;
    private BlockPos lastCompletedConnectedSpawner;
    private final Set<BlockPos> connectedSpawnerGroup = new HashSet<>();
    private final Set<BlockPos> completedConnectedSpawners = new HashSet<>();
    private long noSpawnerSinceMs;
    private long targetSpawnerMissingSinceMs;
    private long targetStackedReappearUntilMs;
    private long nextDisappearanceScanAtMs;
    private int miningLookStableTicks;
    private int miningLookStableTargetTicks;
    private int actionDelayTicks;
    private long suppressTeleportAlertsUntilMs;
    private long suppressDisappearAlertsUntilMs;
    private boolean spawnersMinedSuccessfully;
    private int totalSpawnersCollected;
    private int lastInventorySpawnerCount;
    private int baselineInventorySpawnerCount;
    private boolean suppressWebhookForCurrentRun;
    private long nextActivationScanAtMs;
    private boolean lastActivationScanResult;
    private int joinGraceTicks;
    private boolean serverSneaking;
    private int hugoSneakWarmupTicks;
    private int hugoReminePauseTicks;
    private boolean hugoReminePauseDone;
    private boolean attackClickPulse;
    private final Set<String> remoteWhitelistPlayers = new LinkedHashSet<>();
    private final Map<BlockPos, Long> observedSpawners = new HashMap<>();
    private final Map<BlockPos, Long> pendingDisappearances = new HashMap<>();

    private final SpawnerCache spawnerCache = new SpawnerCache();
    private final InventoryStashManager stashManager = new InventoryStashManager();
    private PlayerThreatScanner threatScanner;

    private enum SpecialCheck {
        UNDER_BEDROCK("Under Bedrock Check");
        private final String title;
        SpecialCheck(String title) { this.title = title; }
    }

    public SpawnerProtectModule() {
        super(WSpawnerProtectAddon.CATEGORY, "SpawnerProtect", "Mines nearby spawners and disconnects when player is detected.");
        spawnerCache.init();
        spawnerCache.setOnSpawnerDisappear((pos, trackedAgeMs) -> {
            handleSpawnerDisappearance(pos, trackedAgeMs);
        });
    }

    @Override
    public void onActivate() {
        suppressWebhookForCurrentRun = suppressWebhookOnNextActivate;
        suppressWebhookOnNextActivate = false;
        refreshThreatScannerWhitelist();
        resetRuntime();
        info("SpawnerProtect active: monitoring for players.");
    }

    @Override
    public void onDeactivate() {
        releaseInputs();
        targetSpawner = null;
        connectedSpawnerAnchor = null;
        lastCompletedConnectedSpawner = null;
        connectedSpawnerGroup.clear();
        completedConnectedSpawners.clear();
        suppressWebhookForCurrentRun = false;
        observedSpawners.clear();
        pendingDisappearances.clear();
        spawnerCache.clear();
    }

    private void resetRuntime() {
        state = State.IDLE;
        trackedWorld = mc.world;
        detectedPlayer = "";
        detectionTimeMs = 0L;
        emergencyTriggered = false;
        emergencyReason = "";
        protectionTriggerPos = null;
        protectionTriggerServer = "";
        protectionTriggerSpawnerCount = 0;
        protectionTriggerSpawnerPositions = "";
        targetSpawner = null;
        connectedSpawnerAnchor = null;
        lastCompletedConnectedSpawner = null;
        connectedSpawnerGroup.clear();
        completedConnectedSpawners.clear();
        stashManager.reset();
        noSpawnerSinceMs = 0L;
        targetSpawnerMissingSinceMs = 0L;
        targetStackedReappearUntilMs = 0L;
        nextDisappearanceScanAtMs = 0L;
        miningLookStableTicks = 0;
        miningLookStableTargetTicks = 0;
        actionDelayTicks = 0;
        suppressTeleportAlertsUntilMs = 0L;
        suppressDisappearAlertsUntilMs = System.currentTimeMillis() + DISAPPEAR_SUPPRESS_AFTER_WORLD_CHANGE_MS;
        spawnersMinedSuccessfully = false;
        totalSpawnersCollected = 0;
        baselineInventorySpawnerCount = currentInventorySpawnerCount();
        lastInventorySpawnerCount = baselineInventorySpawnerCount;
        nextActivationScanAtMs = 0L;
        lastActivationScanResult = false;
        joinGraceTicks = 40; // 2 seconds grace period
        serverSneaking = false;
        hugoSneakWarmupTicks = 0;
        hugoReminePauseTicks = 0;
        hugoReminePauseDone = false;
        attackClickPulse = false;
        observedSpawners.clear();
        pendingDisappearances.clear();
        spawnerCache.clear();
        releaseInputs();
    }

    @EventHandler
    private void onTick(TickEvent.Pre event) {
        if (mc.player == null || mc.world == null) return;

        refreshThreatScannerWhitelist();

        if (trackedWorld != mc.world) {
            handleWorldChangedDuringProtection();
        }

        if (actionDelayTicks > 0) {
            actionDelayTicks--;
            return;
        }

        if (joinGraceTicks > 0) {
            joinGraceTicks--;
        } else if (threatScanner != null && teleportCheck.get()) {
            threatScanner.checkTeleport((from, to, dist) -> {
                if (isTeleportAlertSuppressed()) return;
                // Now passive: only webhook, no disconnect/disable.
                sendTeleportWebhookAsync(from, to, dist);
                startMaintenanceHomeRecoveryAfterTeleport(dist);
            });
        }

        switch (state) {
            case IDLE -> {
                monitorSpawnerDisappearances();
                monitorPlayers();
            }
            case MINING_SPAWNERS -> mineSpawners();
            case STORING_ITEMS -> storeItemsInNearestEnderChest();
            case DISCONNECTING -> disconnectNow();
        }
    }

    @EventHandler
    private void onReceiveMessage(ReceiveMessageEvent event) {
        if (event == null || event.getMessage() == null) return;
        String message = event.getMessage().getString();
        if (isAfkTeleportMessage(message)) sendAfkTeleportWebhookAsync(message);
    }

    @EventHandler
    private void onBlockUpdate(BlockUpdateEvent event) {
        if (event == null || event.newState == null) return;
        if (event.newState.getBlock() != Blocks.SPAWNER) return;

        long untilMs = System.currentTimeMillis() + DISAPPEAR_SUPPRESS_AFTER_SPAWNER_PLACE_MS;
        suppressDisappearAlertsUntilMs = Math.max(suppressDisappearAlertsUntilMs, untilMs);
        observedSpawners.clear();
        pendingDisappearances.clear();
    }

    private void triggerEmergency(String reason) {
        emergencyTriggered = true;
        emergencyReason = reason;
        state = State.DISCONNECTING;
        info("Emergency trigger: " + reason);
    }

    private void handleWorldChangedDuringProtection() {
        World previousWorld = trackedWorld;
        trackedWorld = mc.world;
        observedSpawners.clear();
        pendingDisappearances.clear();
        spawnerCache.clear();
        nextDisappearanceScanAtMs = System.currentTimeMillis() + DISAPPEAR_SUPPRESS_AFTER_WORLD_CHANGE_MS;
        suppressDisappearAlertsUntilMs = nextDisappearanceScanAtMs;
        joinGraceTicks = Math.max(joinGraceTicks, 40);

        if (previousWorld != null && state != State.IDLE) {
            triggerEmergency("World changed during protection sequence");
        }
    }

    private void monitorPlayers() {
        if (AdminList.shouldBlockProtectedAutomation()) return;
        
        PlayerEntity targetPlayer = threatScanner.findClosestThreatPlayer();
        if (targetPlayer == null) return;
        if (!canActivateForProtection()) return;

        SpecialCheck specialCheck = detectSpecialCheck(targetPlayer);
        if (specialCheck != null) {
            handleSpecialCheck(targetPlayer, specialCheck);
            return;
        }

        String name = targetPlayer.getName().getString();
        double distance = mc.player.distanceTo(targetPlayer);
        prepareProtectionTrigger(name);

        if (distanceCheck.get() && distance <= emergencyDistance.get()) {
            triggerEmergency("Player " + name + " is " + String.format("%.1f", distance) + " blocks away");
            return;
        }

        state = State.MINING_SPAWNERS;
        info("Player detected: " + name + ". Starting spawner protection.");
    }

    public void setRemoteWhitelistPlayers(List<String> playerNames) {
        remoteWhitelistPlayers.clear();
        if (playerNames == null) return;
        for (String playerName : playerNames) {
            String normalized = playerName == null ? "" : playerName.trim();
            if (normalized.isEmpty()) continue;
            if (!normalized.matches(VALID_MC_NAME_REGEX)) continue;
            remoteWhitelistPlayers.add(normalized.toLowerCase(Locale.ROOT));
        }
        if (isActive()) {
            refreshThreatScannerWhitelist();
        }
    }

    private void refreshThreatScannerWhitelist() {
        boolean whitelistActive = enableWhitelist.get() && !ignoreSharedWhitelistForTesting.get();
        Set<String> effectiveRemoteWhitelist = whitelistActive ? effectiveRemoteWhitelistPlayers() : Set.of();
        if (threatScanner == null) {
            threatScanner = new PlayerThreatScanner(effectiveRemoteWhitelist, whitelistPlayers.get(), whitelistActive);
            return;
        }

        threatScanner.updateWhitelist(effectiveRemoteWhitelist, whitelistPlayers.get(), whitelistActive);
    }

    private Set<String> effectiveRemoteWhitelistPlayers() {
        LinkedHashSet<String> effective = new LinkedHashSet<>(remoteWhitelistPlayers);
        effective.addAll(BUILTIN_WHITELIST_PLAYERS);
        return effective;
    }

    private void mineSpawners() {
        long nowMs = System.currentTimeMillis();
        updateCollectedSpawners(nowMs);

        if (shouldEmergencyFromNearbyPlayer()) {
            state = State.DISCONNECTING;
            return;
        }

        if (targetSpawner == null || !isRealSpawner(targetSpawner)) {
            if (targetSpawner != null) {
                if (isHugoSmpServer()) {
                    noSpawnerSinceMs = 0L;
                    setSneaking(true);
                    if (!hugoReminePauseDone) startHugoReminePause();
                    if (hugoReminePauseTicks > 0) {
                        holdHugoReminePause();
                        return;
                    }
                    keepHoldingCurrentSpawner(targetSpawner);

                    if (targetSpawnerMissingSinceMs == 0L) {
                        targetSpawnerMissingSinceMs = nowMs;
                    } else if (nowMs - targetSpawnerMissingSinceMs >= effectiveTargetGoneConfirmMs(nowMs)) {
                        markConnectedSpawnerCompleted(targetSpawner);
                        spawnerCache.ignoreSpawner(targetSpawner, MINED_TARGET_IGNORE_MS);
                        targetSpawner = null;
                        spawnerCache.setCurrentTarget(null);
                        targetSpawnerMissingSinceMs = 0L;
                        targetStackedReappearUntilMs = 0L;
                        hugoSneakWarmupTicks = 0;
                        hugoReminePauseTicks = 0;
                        hugoReminePauseDone = false;
                        attackClickPulse = false;
                        BlockInteractionUtil.resetRotationSmoothing();
                        miningLookStableTicks = 0;
                        miningLookStableTargetTicks = 0;
                    }

                    if (targetSpawner != null) return;
                }

                if (switchToCrosshairSpawnerTarget()) {
                    setSneaking(true);
                    holdAttack(targetSpawner);
                    return;
                }

                if (targetSpawnerMissingSinceMs == 0L) {
                    targetSpawnerMissingSinceMs = nowMs;
                    targetStackedReappearUntilMs = Math.max(targetStackedReappearUntilMs, nowMs + nonHugoDisappearedTargetHoldMs());
                }

                if (nowMs < targetStackedReappearUntilMs) {
                    noSpawnerSinceMs = 0L;
                    setSneaking(true);
                    continueTargetMining(targetSpawner, false);
                    return;
                }

                if (nowMs - targetSpawnerMissingSinceMs >= effectiveTargetGoneConfirmMs(nowMs)) {
                    markConnectedSpawnerCompleted(targetSpawner);
                    spawnerCache.ignoreSpawner(targetSpawner, MINED_TARGET_IGNORE_MS);
                    targetSpawner = null;
                    spawnerCache.setCurrentTarget(null);
                    targetSpawnerMissingSinceMs = 0L;
                    targetStackedReappearUntilMs = 0L;
                    hugoSneakWarmupTicks = 0;
                    hugoReminePauseTicks = 0;
                    hugoReminePauseDone = false;
                    attackClickPulse = false;
                    BlockInteractionUtil.resetRotationSmoothing();
                    miningLookStableTicks = 0;
                    miningLookStableTargetTicks = 0;
                }

                if (targetSpawner != null) {
                    noSpawnerSinceMs = 0L;
                    setSneaking(true);
                    if (isHugoSmpServer()) releaseAttack();
                    else continueTargetMining(targetSpawner, false);
                    return;
                }
            }

            if (targetSpawner == null) {
                setTargetSpawner(findPreferredSpawnerTarget());
                if (isHugoSmpServer() && targetSpawner != null) {
                    serverSneaking = false;
                }
                hugoSneakWarmupTicks = 0;
                hugoReminePauseTicks = 0;
                hugoReminePauseDone = false;
                BlockInteractionUtil.resetRotationSmoothing();
                miningLookStableTicks = 0;
                miningLookStableTargetTicks = 0;
            }
        } else {
            targetSpawnerMissingSinceMs = 0L;
        }

        if (targetSpawner == null) {
            setSneaking(false);
            releaseAttack();
            if (noSpawnerSinceMs == 0L) {
                noSpawnerSinceMs = nowMs;
                info("No spawner found. Confirming clear area...");
            } else if (nowMs - noSpawnerSinceMs >= effectiveNoSpawnerConfirmMs()) {
                if (reacquireVisibleSpawnerIfAny()) return;
                noSpawnerSinceMs = 0L;
                setSneaking(false);
                releaseAttack();
                spawnersMinedSuccessfully = true;
                startPostMiningSequence();
            }
            return;
        }

        noSpawnerSinceMs = 0L;

        setSneaking(true);

        if (isHugoSmpServer() && hugoReminePauseTicks > 0) {
            holdHugoReminePause();
            return;
        }

        if (isHugoSmpServer() && hugoSneakWarmupTicks < HUGO_SNEAK_WARMUP_TICKS) {
            hugoSneakWarmupTicks++;
            lookAt(targetSpawner);
            releaseAttackKeyOnly();
            return;
        }

        if (!BlockInteractionUtil.faceBlockUntilReady(mc.player, targetSpawner, FAST_SPAWNER_YAW_STEP, FAST_SPAWNER_PITCH_STEP)) {
            miningLookStableTicks = 0;
            miningLookStableTargetTicks = 0;
            keepAttackHeldWhileApproaching(targetSpawner);
            return;
        }

        if (miningLookStableTargetTicks <= 0) miningLookStableTargetTicks = randomLookStableTicks();
        if (++miningLookStableTicks < miningLookStableTargetTicks) {
            keepAttackHeldWhileApproaching(targetSpawner);
            return;
        }

        holdAttack(targetSpawner);

        if (!isRealSpawner(targetSpawner)) {
            if (!isHugoSmpServer() && switchToCrosshairSpawnerTarget()) {
                holdAttack(targetSpawner);
                return;
            }

            if (targetSpawnerMissingSinceMs == 0L) {
                targetSpawnerMissingSinceMs = nowMs;
                if (!isHugoSmpServer()) {
                    targetStackedReappearUntilMs = Math.max(targetStackedReappearUntilMs, nowMs + nonHugoDisappearedTargetHoldMs());
                }
            }

            if (nowMs < targetStackedReappearUntilMs) return;

            if (nowMs - targetSpawnerMissingSinceMs >= effectiveTargetGoneConfirmMs(nowMs)) {
                if (isHugoSmpServer()) releaseAttack();
                else continueTargetMining(targetSpawner, false);
                markConnectedSpawnerCompleted(targetSpawner);
                spawnerCache.ignoreSpawner(targetSpawner, MINED_TARGET_IGNORE_MS);
                targetSpawner = null;
                spawnerCache.setCurrentTarget(null);
                targetSpawnerMissingSinceMs = 0L;
                targetStackedReappearUntilMs = 0L;
                hugoSneakWarmupTicks = 0;
                hugoReminePauseTicks = 0;
                hugoReminePauseDone = false;
                attackClickPulse = false;
                BlockInteractionUtil.resetRotationSmoothing();
                miningLookStableTicks = 0;
                miningLookStableTargetTicks = 0;
                actionDelayTicks = 0;
            }
        } else {
            targetSpawnerMissingSinceMs = 0L;
        }
    }

    private boolean shouldEmergencyFromNearbyPlayer() {
        PlayerEntity player = threatScanner.findClosestThreatPlayer();
        if (player == null) return false;

        double distance = mc.player.distanceTo(player);
        if (distanceCheck.get() && distance <= emergencyDistance.get()) {
            String name = player.getName().getString();
            detectedPlayer = name;
            triggerEmergency("Player " + name + " moved too close: " + String.format("%.1f", distance) + " blocks");
            return true;
        }
        return false;
    }

    private void startPostMiningSequence() {
        if (prepareInventoryDeposit()) {
            state = State.STORING_ITEMS;
            BlockInteractionUtil.resetRotationSmoothing();
            actionDelayTicks = 0;
            info("Spawner area clear. Moving inventory into nearest ender chest.");
            return;
        }
        state = State.DISCONNECTING;
        info("Spawner area clear. Disconnecting immediately.");
    }

    private boolean prepareInventoryDeposit() {
        if (!stashManager.hasTransferableInventoryItems()) return false;
        
        BlockPos nearestChest = stashManager.findNearestEnderChest(enderChestRange.get());
        stashManager.setTargetEnderChest(nearestChest);
        
        BlockInteractionUtil.resetRotationSmoothing();
        if (nearestChest != null) return true;

        warning("No nearby ender chest found. Disconnecting with remaining inventory.");
        return false;
    }

    private void storeItemsInNearestEnderChest() {
        setSneaking(false);
        releaseAttack();

        if (shouldEmergencyFromNearbyPlayer()) {
            state = State.DISCONNECTING;
            return;
        }

        if (!stashManager.hasTransferableInventoryItems()) {
            stashManager.closeHandledScreenIfOpen();
            info("Inventory moved to ender chest. Disconnecting.");
            state = State.DISCONNECTING;
            return;
        }

        BlockPos targetChest = stashManager.getTargetEnderChest();
        if (targetChest == null || mc.world.getBlockState(targetChest).getBlock() != Blocks.ENDER_CHEST) {
            targetChest = stashManager.findNearestEnderChest(enderChestRange.get());
            stashManager.setTargetEnderChest(targetChest);
            BlockInteractionUtil.resetRotationSmoothing();
            if (targetChest == null) {
                warning("Ender chest is not available anymore. Disconnecting with remaining inventory.");
                state = State.DISCONNECTING;
                return;
            }
        }

        if (mc.currentScreen instanceof GenericContainerScreen && mc.player.currentScreenHandler instanceof GenericContainerScreenHandler handler) {
            boolean movedStacks = stashManager.transferItemsToChest(handler);
            boolean inventoryRemain = stashManager.hasTransferableInventoryItems();

            if (movedStacks) {
                if (inventoryRemain) {
                    actionDelayTicks = inventoryTransferClickDelayTicks.get();
                    return;
                }
                stashManager.closeHandledScreenIfOpen();
                info("Inventory moved to ender chest. Disconnecting.");
                state = State.DISCONNECTING;
                actionDelayTicks = inventoryTransferDelayTicks.get();
                return;
            }

            stashManager.closeHandledScreenIfOpen();
            if (!inventoryRemain) {
                info("Inventory moved to ender chest. Disconnecting.");
                state = State.DISCONNECTING;
                actionDelayTicks = inventoryTransferDelayTicks.get();
                return;
            }

            warning("Failed to store all inventory items into the ender chest. Disconnecting with remaining inventory.");
            state = State.DISCONNECTING;
            actionDelayTicks = inventoryTransferDelayTicks.get();
            return;
        }

        if (stashManager.shouldCloseOpenMenuBeforeChestOpen()) return;

        InventoryStashManager.OpenResult openResult = stashManager.openTargetEnderChest(FAST_CHEST_YAW_STEP, FAST_CHEST_PITCH_STEP, 6);
        if (openResult == InventoryStashManager.OpenResult.FAILED && stashManager.getTargetEnderChest() != null) {
            warning("Failed to open nearby ender chest. Disconnecting with remaining inventory.");
            state = State.DISCONNECTING;
            actionDelayTicks = inventoryTransferDelayTicks.get();
            return;
        }

        if (openResult == InventoryStashManager.OpenResult.CLICKED) {
            actionDelayTicks = Math.max(2, inventoryTransferDelayTicks.get());
        }
    }

    private void disconnectNow() {
        releaseInputs();
        stashManager.closeHandledScreenIfOpen();
        if (!suppressWebhookForCurrentRun) sendWebhookAsync();
        
        if (disconnectOnTrigger.get()) {
            reactivateOnNextJoin = true;
            suppressAutoReconnectOnNextJoin = true;

            if (emergencyTriggered) {
                info("Disconnecting (emergency): " + emergencyReason);
            } else {
                info("Disconnecting after protection trigger. Player: " + detectedPlayer);
            }

            if (mc.world != null) {
                mc.world.disconnect(Text.of("WProtect disconnect"));
            }
        } else {
            warning("Protection triggered, but disconnect is disabled. Toggling off module.");
            toggle();
        }
        state = State.IDLE;
    }

    public static void suppressWebhookForNextActivation() { suppressWebhookOnNextActivate = true; }
    public static boolean consumeReactivateOnNextJoin() { 
        if (!reactivateOnNextJoin) return false;
        reactivateOnNextJoin = false;
        return true;
    }
    public boolean shouldAutoEnableOnServerJoin() { return autoEnableOnServerJoin.get(); }
    public static boolean consumeSuppressAutoReconnectOnNextJoin() {
        if (!suppressAutoReconnectOnNextJoin) return false;
        suppressAutoReconnectOnNextJoin = false;
        return true;
    }
    public static boolean isSuppressAutoReconnectOnNextJoinPending() { return suppressAutoReconnectOnNextJoin; }

    public void suppressTeleportAlertsFor(long durationMs) {
        long untilMs = System.currentTimeMillis() + Math.max(0L, durationMs);
        suppressTeleportAlertsUntilMs = Math.max(suppressTeleportAlertsUntilMs, untilMs);
    }

    private boolean isTeleportAlertSuppressed() {
        return System.currentTimeMillis() < suppressTeleportAlertsUntilMs;
    }

    public void handleDisconnectInfo(Text reasonText) {
        String reason = textToPlainString(reasonText);
        if (!isModerationDisconnect(reason) || isOwnProtectionDisconnect(reason)) return;

        boolean autoReconnectWasActive = false;
        Module autoReconnect = Modules.get().get(AutoReconnect.class);
        if (autoReconnect instanceof AutoReconnect autoReconnectModule) {
            autoReconnectWasActive = autoReconnectModule.isActive() || autoReconnectModule.hasPendingReconnect();
            autoReconnectModule.cancelReconnect();
        } else if (autoReconnect != null) {
            autoReconnectWasActive = autoReconnect.isActive();
        }
        if (autoReconnect != null && autoReconnect.isActive()) autoReconnect.toggle();

        String dedupKey = "spawner-protect-disconnect:" + botAccount().toLowerCase(Locale.ROOT) + ":" + normalizeForMatch(reason);
        if (!DiscordWebhookClient.allowDedup(dedupKey, BAN_ALERT_DEDUP_MS)) return;

        sendModerationDisconnectWebhookAsync(reason, autoReconnectWasActive);
    }

    private void disableAutoReconnectIfEnabled() {
        Module autoReconnect = Modules.get().get(AutoReconnect.class);
        if (autoReconnect instanceof AutoReconnect autoReconnectModule) autoReconnectModule.cancelReconnect();
        if (autoReconnect != null && autoReconnect.isActive()) {
            autoReconnect.toggle();
            info("Disabled AutoReconnect.");
        }
    }

    private void disableSpawnerDropperIfEnabled() {
        Module spawnerDropper = Modules.get().get(SpawnerDropperModule.class);
        if (spawnerDropper != null && spawnerDropper.isActive()) {
            spawnerDropper.toggle();
            info("Disabled SpawnerDropper.");
        }
    }

    public boolean canActivateForProtection() {
        if (mc == null || mc.player == null || mc.world == null) return false;
        if (AdminList.shouldBlockProtectedAutomation()) return false;
        long now = System.currentTimeMillis();
        if (now < nextActivationScanAtMs) return lastActivationScanResult;

        lastActivationScanResult = hasSpawnerInInventory() || spawnerCache.hasNearbySpawner(mc.player.getBlockPos(), scanRange.get());
        nextActivationScanAtMs = now + activationScanIntervalMs.get();
        return lastActivationScanResult;
    }

    private boolean hasSpawnerInInventory() {
        for (int i = 0; i < 36; i++) {
            ItemStack stack = mc.player.getInventory().getStack(i);
            if (!stack.isEmpty() && stack.isOf(Items.SPAWNER)) return true;
        }
        return false;
    }

    private boolean isRealSpawner(BlockPos pos) {
        return SpawnerBlockUtil.isRealSpawner(mc.world, pos);
    }

    private SpecialCheck detectSpecialCheck(PlayerEntity player) {
        if (player == null || mc.world == null) return null;
        if (threatScanner.isUnderBedrock(player)) return SpecialCheck.UNDER_BEDROCK;
        return null;
    }

    private void handleSpecialCheck(PlayerEntity player, SpecialCheck check) {
        if (player == null || check == null) return;
        String playerName = player.getName().getString();
        String dedupKey = "spawner-protect-check:" + check.name() + ":" + playerName.toLowerCase(Locale.ROOT);
        boolean shouldNotify = DiscordWebhookClient.allowDedup(dedupKey, SPECIAL_CHECK_DEDUP_MS);
        if (!shouldNotify) return;

        warning("Special check detected: " + check.title + " by " + playerName + ". SpawnerProtect will not start mining.");
        sendSpecialCheckWebhookAsync(player, check);
    }

    private void prepareProtectionTrigger(String detectedLabel) {
        detectedPlayer = detectedLabel == null || detectedLabel.isBlank() ? "Unknown" : detectedLabel;
        detectionTimeMs = System.currentTimeMillis();
        trackedWorld = mc.world;
        captureProtectionWebhookContext();
        targetSpawner = null;
        connectedSpawnerAnchor = null;
        lastCompletedConnectedSpawner = null;
        connectedSpawnerGroup.clear();
        completedConnectedSpawners.clear();
        spawnerCache.setCurrentTarget(null);
        stashManager.reset();
        BlockInteractionUtil.resetRotationSmoothing();
        noSpawnerSinceMs = 0L;
        targetSpawnerMissingSinceMs = 0L;
        hugoSneakWarmupTicks = 0;
        hugoReminePauseTicks = 0;
        hugoReminePauseDone = false;
        attackClickPulse = false;
        emergencyTriggered = false;
        emergencyReason = "";

        disableAutoReconnectIfEnabled();
        disableSpawnerDropperIfEnabled();
    }

    private void lookAt(BlockPos pos) {
        if (mc.player == null || pos == null) return;
        BlockInteractionUtil.faceBlock(mc.player, pos, FAST_SPAWNER_YAW_STEP, FAST_SPAWNER_PITCH_STEP);
    }

    private void holdAttack(BlockPos pos) {
        continueTargetMining(pos, true);
    }

    private void continueTargetMining(BlockPos pos, boolean pressAttackKey) {
        if (mc.interactionManager == null || mc.player == null) return;
        Direction facing = BlockInteractionUtil.createBlockHitResult(mc.player, pos).getSide();
        lookAt(pos);
        if (attackClickPulse) {
            pulseAttackClick(pos, facing);
            attackClickPulse = false;
        }
        mc.interactionManager.updateBlockBreakingProgress(pos, facing);
        mc.options.attackKey.setPressed(pressAttackKey);
        mc.player.swingHand(Hand.MAIN_HAND);
    }

    private void keepHoldingCurrentSpawner(BlockPos pos) {
        holdAttack(pos);
    }

    private void keepAttackHeldWhileApproaching(BlockPos pos) {
        continueTargetMining(pos, false);
    }

    private void startHugoReminePause() {
        if (hugoReminePauseDone) return;
        hugoReminePauseDone = true;
        hugoReminePauseTicks = HUGO_REMINE_PAUSE_TICKS;
        hugoSneakWarmupTicks = 0;
        serverSneaking = false;
        attackClickPulse = true;
        miningLookStableTicks = 0;
        miningLookStableTargetTicks = 1;
    }

    private void holdHugoReminePause() {
        setSneaking(true);
        releaseAttack();
        if (targetSpawner != null) lookAt(targetSpawner);
        if (hugoReminePauseTicks > 0) hugoReminePauseTicks--;
    }

    private void pulseAttackClick(BlockPos pos, Direction facing) {
        if (mc == null || mc.options == null || mc.options.attackKey == null || mc.interactionManager == null || mc.player == null) return;
        if (!(mc.options.attackKey instanceof KeyBindingAccessor accessor)) return;
        KeyBinding.onKeyPressed(accessor.wsp$getBoundKey());
        mc.interactionManager.attackBlock(pos, facing);
        mc.options.attackKey.setPressed(true);
        mc.player.swingHand(Hand.MAIN_HAND);
    }

    private void releaseAttack() {
        if (mc == null || mc.options == null) return;
        mc.options.attackKey.setPressed(false);
        if (mc.interactionManager != null) mc.interactionManager.cancelBlockBreaking();
    }

    private void releaseAttackKeyOnly() {
        if (mc == null || mc.options == null) return;
        mc.options.attackKey.setPressed(false);
    }

    private void setSneaking(boolean sneak) {
        if (mc == null || mc.player == null) return;
        mc.player.setSneaking(sneak);
        if (mc.options != null) mc.options.sneakKey.setPressed(sneak);
        if ((!sneak || serverSneaking != sneak) && mc.player.networkHandler != null) {
            mc.player.networkHandler.sendPacket(new PlayerInputC2SPacket(new PlayerInput(false, false, false, false, false, sneak, false)));
            serverSneaking = sneak;
        }
    }

    private void releaseInputs() {
        if (mc == null) return;
        releaseAttack();
        setSneaking(false);
        if (mc.options == null) return;
        mc.options.jumpKey.setPressed(false);
        mc.options.forwardKey.setPressed(false);
    }

    private int randomLookStableTicks() {
        return ThreadLocalRandom.current().nextInt(1, 3);
    }

    private long effectiveTargetGoneConfirmMs(long nowMs) {
        long fastConfirmMs = Math.min(Math.max(50L, confirmTargetGoneMs.get()), MAX_EFFECTIVE_TARGET_GONE_CONFIRM_MS);
        if (isHugoSmpServer()) {
            return Math.max(fastConfirmMs, HUGO_TARGET_GONE_CONFIRM_MS);
        }
        if (nowMs < targetStackedReappearUntilMs) {
            return Math.max(fastConfirmMs, stackedSpawnerWaitMs());
        }
        return Math.max(fastConfirmMs, NON_HUGO_TARGET_GONE_CONFIRM_MS);
    }

    private long effectiveNoSpawnerConfirmMs() {
        long fastConfirmMs = Math.min(Math.max(50L, confirmNoSpawnerMs.get()), MAX_EFFECTIVE_NO_SPAWNER_CONFIRM_MS);
        if (isHugoSmpServer()) return fastConfirmMs;
        return Math.max(fastConfirmMs, Math.max(NON_HUGO_NO_SPAWNER_CONFIRM_MS, stackedSpawnerWaitMs()));
    }

    private long stackedSpawnerWaitMs() {
        return Math.max(300L, stackedSpawnerReappearWaitMs.get());
    }

    private long nonHugoDisappearedTargetHoldMs() {
        return Math.min(stackedSpawnerWaitMs(), NON_HUGO_DISAPPEARED_TARGET_HOLD_MS);
    }

    private BlockPos findPreferredSpawnerTarget() {
        List<BlockPos> visibleSpawners = findVisibleSpawnersSorted();
        if (visibleSpawners.isEmpty()) {
            BlockPos fallback = spawnerCache.getNearestSpawner(mc.player.getBlockPos(), scanRange.get());
            if (fallback != null && connectedSpawnerGroup.isEmpty()) startConnectedSpawnerGroup(List.of(fallback), fallback);
            return fallback;
        }

        BlockPos existingGroupTarget = findNearestSavedGroupSpawner(visibleSpawners);
        if (existingGroupTarget != null) return existingGroupTarget;

        BlockPos nextGroup = visibleSpawners.get(0);
        startConnectedSpawnerGroup(visibleSpawners, nextGroup);
        return nextGroup;
    }

    private void setTargetSpawner(BlockPos pos) {
        targetSpawner = pos == null ? null : pos.toImmutable();
        spawnerCache.setCurrentTarget(targetSpawner);
        if (targetSpawner != null) attackClickPulse = true;
    }

    private boolean switchToCrosshairSpawnerTarget() {
        BlockPos crosshairSpawner = currentCrosshairSpawner();
        if (crosshairSpawner == null) return false;
        if (targetSpawner != null && crosshairSpawner.equals(targetSpawner)) return false;

        if (targetSpawner != null) {
            markConnectedSpawnerCompleted(targetSpawner);
            spawnerCache.ignoreSpawner(targetSpawner, MINED_TARGET_IGNORE_MS);
        }

        targetSpawner = crosshairSpawner.toImmutable();
        spawnerCache.unignoreSpawner(targetSpawner);
        spawnerCache.setCurrentTarget(targetSpawner);
        targetSpawnerMissingSinceMs = 0L;
        targetStackedReappearUntilMs = 0L;
        miningLookStableTicks = 0;
        miningLookStableTargetTicks = 0;
        attackClickPulse = false;
        return true;
    }

    private BlockPos currentCrosshairSpawner() {
        if (mc == null || mc.player == null || mc.world == null) return null;
        HitResult hit = mc.player.raycast(5.0D, 0.0f, false);
        if (!(hit instanceof BlockHitResult blockHit)) return null;
        if (blockHit.getType() != HitResult.Type.BLOCK) return null;

        BlockPos pos = blockHit.getBlockPos();
        return isRealSpawner(pos) ? pos.toImmutable() : null;
    }

    private boolean reacquireVisibleSpawnerIfAny() {
        BlockPos visibleSpawner = findPreferredSpawnerTarget();
        if (visibleSpawner == null) return false;

        setTargetSpawner(visibleSpawner);
        spawnerCache.unignoreSpawner(targetSpawner);
        noSpawnerSinceMs = 0L;
        targetSpawnerMissingSinceMs = 0L;
        targetStackedReappearUntilMs = 0L;
        hugoSneakWarmupTicks = 0;
        hugoReminePauseTicks = 0;
        hugoReminePauseDone = false;
        BlockInteractionUtil.resetRotationSmoothing();
        miningLookStableTicks = 0;
        miningLookStableTargetTicks = 0;
        info("Final rescan found a remaining spawner. Continuing mining.");
        return true;
    }

    private BlockPos findNearestVisibleSpawner() {
        List<BlockPos> spawners = findVisibleSpawnersSorted();
        return spawners.isEmpty() ? null : spawners.get(0);
    }

    private BlockPos findNearestSavedGroupSpawner(List<BlockPos> visibleSpawners) {
        if (connectedSpawnerGroup.isEmpty() || visibleSpawners == null || visibleSpawners.isEmpty()) return null;

        List<BlockPos> remaining = new ArrayList<>();
        for (BlockPos pos : visibleSpawners) {
            if (connectedSpawnerGroup.contains(pos)) remaining.add(pos);
        }

        if (remaining.isEmpty()) {
            connectedSpawnerGroup.clear();
            connectedSpawnerAnchor = null;
            lastCompletedConnectedSpawner = null;
            completedConnectedSpawners.clear();
            return null;
        }

        BlockPos origin = mc.player.getBlockPos();
        BlockPos anchor = connectedSpawnerAnchor == null ? remaining.get(0) : connectedSpawnerAnchor;
        BlockPos frontierAnchor = lastCompletedConnectedSpawner;
        List<BlockPos> frontier = new ArrayList<>();
        for (BlockPos pos : remaining) {
            if (isAdjacentToCompletedConnectedSpawner(pos)) frontier.add(pos);
        }

        if (!frontier.isEmpty()) {
            BlockPos sortAnchor = frontierAnchor == null ? anchor : frontierAnchor;
            frontier.sort((a, b) -> compareSpawnerTargets(a, b, sortAnchor, origin));
            return frontier.get(0);
        }

        remaining.sort((a, b) -> compareSpawnerTargets(a, b, anchor, origin));
        return remaining.get(0);
    }

    private void startConnectedSpawnerGroup(List<BlockPos> visibleSpawners, BlockPos anchor) {
        connectedSpawnerGroup.clear();
        connectedSpawnerAnchor = anchor == null ? null : anchor.toImmutable();
        lastCompletedConnectedSpawner = null;
        completedConnectedSpawners.clear();
        if (anchor == null) return;

        List<BlockPos> connected = findConnectedSpawners(visibleSpawners, connectedSpawnerAnchor);
        connectedSpawnerGroup.add(connectedSpawnerAnchor);
        connectedSpawnerGroup.addAll(connected);
    }

    private void markConnectedSpawnerCompleted(BlockPos pos) {
        if (pos == null || connectedSpawnerGroup.isEmpty()) return;
        BlockPos immutable = pos.toImmutable();
        if (connectedSpawnerGroup.contains(immutable)) {
            completedConnectedSpawners.add(immutable);
            lastCompletedConnectedSpawner = immutable;
        }
    }

    private boolean isAdjacentToCompletedConnectedSpawner(BlockPos pos) {
        if (pos == null || completedConnectedSpawners.isEmpty()) return false;
        for (Direction direction : Direction.values()) {
            if (completedConnectedSpawners.contains(pos.offset(direction))) return true;
        }
        return false;
    }

    private int compareSpawnerTargets(BlockPos a, BlockPos b, BlockPos anchor, BlockPos origin) {
        BlockPos safeAnchor = anchor == null ? origin : anchor;
        int anchorCompare = Double.compare(a.getSquaredDistance(safeAnchor), b.getSquaredDistance(safeAnchor));
        if (anchorCompare != 0) return anchorCompare;
        return Double.compare(a.getSquaredDistance(origin), b.getSquaredDistance(origin));
    }

    private List<BlockPos> findConnectedSpawners(List<BlockPos> visibleSpawners, BlockPos anchor) {
        List<BlockPos> connected = new ArrayList<>();
        if (anchor == null || visibleSpawners == null || visibleSpawners.isEmpty()) return connected;

        Set<BlockPos> visibleSet = new HashSet<>(visibleSpawners);
        Set<BlockPos> visited = new HashSet<>();
        ArrayDeque<BlockPos> queue = new ArrayDeque<>();

        queue.add(anchor.toImmutable());
        visited.add(anchor.toImmutable());

        while (!queue.isEmpty()) {
            BlockPos current = queue.removeFirst();
            for (Direction direction : Direction.values()) {
                BlockPos next = current.offset(direction).toImmutable();
                if (!visited.add(next)) continue;
                if (!visibleSet.contains(next)) continue;

                connected.add(next);
                queue.add(next);
            }
        }

        return connected;
    }

    private List<BlockPos> findVisibleSpawnersSorted() {
        List<BlockPos> spawners = new ArrayList<>();
        if (mc == null || mc.player == null || mc.world == null) return spawners;

        BlockPos origin = mc.player.getBlockPos();
        int safeRange = Math.max(1, scanRange.get());
        double rangeSq = safeRange * safeRange;

        for (BlockPos mutable : BlockPos.iterate(
            origin.add(-safeRange, -safeRange, -safeRange),
            origin.add(safeRange, safeRange, safeRange)
        )) {
            if (!isRealSpawner(mutable)) continue;

            double distanceSq = mutable.getSquaredDistance(origin);
            if (distanceSq > rangeSq) continue;
            spawners.add(mutable.toImmutable());
        }

        spawners.sort((a, b) -> Double.compare(a.getSquaredDistance(origin), b.getSquaredDistance(origin)));
        return spawners;
    }

    private void updateCollectedSpawners(long nowMs) {
        int current = currentInventorySpawnerCount();
        if (current > lastInventorySpawnerCount && targetSpawner != null) {
            if (isHugoSmpServer()) {
                startHugoReminePause();
            } else {
                targetStackedReappearUntilMs = Math.max(
                    targetStackedReappearUntilMs,
                    nowMs + stackedSpawnerWaitMs()
                );
            }
        }
        totalSpawnersCollected = Math.max(totalSpawnersCollected, Math.max(0, current - baselineInventorySpawnerCount));
        lastInventorySpawnerCount = current;
    }

    private int actualCollectedSpawnerCount() {
        int current = currentInventorySpawnerCount();
        int collected = Math.max(0, current - baselineInventorySpawnerCount);
        totalSpawnersCollected = Math.max(totalSpawnersCollected, collected);
        lastInventorySpawnerCount = current;
        return totalSpawnersCollected;
    }

    private boolean isHugoSmpServer() {
        if (mc == null) return false;
        ServerInfo server = mc.getCurrentServerEntry();
        if (server == null || server.address == null) return false;

        String address = server.address.trim().toLowerCase(Locale.ROOT);
        if (address.isEmpty()) return false;

        int slashIndex = address.indexOf('/');
        if (slashIndex >= 0) address = address.substring(0, slashIndex);

        int colonIndex = address.indexOf(':');
        if (colonIndex >= 0) address = address.substring(0, colonIndex);

        return address.equals(HUGO_SMP_HOST) || address.endsWith("." + HUGO_SMP_HOST);
    }

    private int currentInventorySpawnerCount() {
        if (mc == null || mc.player == null) return 0;

        int current = 0;
        for (int i = 0; i < 36; i++) {
            ItemStack stack = mc.player.getInventory().getStack(i);
            if (!stack.isEmpty() && stack.isOf(Items.SPAWNER)) current += stack.getCount();
        }
        return current;
    }

    // ─── Webhook helpers ───────────────────────────────────────────────────────

    private void captureProtectionWebhookContext() {
        protectionTriggerServer = currentServerLabel();
        protectionTriggerPos = mc.player == null ? null : mc.player.getBlockPos().toImmutable();

        List<BlockPos> visibleSpawners = findVisibleSpawnersSorted();
        protectionTriggerSpawnerCount = visibleSpawners.size();
        protectionTriggerSpawnerPositions = formatSpawnerPositions(visibleSpawners, 8);
    }

    /** Builds the common ping prefix and current-time field value. */
    private String buildPing() {
        return selfPing.get() && !discordId.get().trim().isEmpty() ? "<@" + discordId.get().trim() + ">" : "";
    }

    /** Returns Discord timestamp string for time-only display (no date). */
    private static String timeField(long epochMs) {
        return "<t:" + (epochMs / 1000L) + ":R>";
    }

    private String botAccount() {
        return mc.getSession() != null ? mc.getSession().getUsername() : "Unknown";
    }

    private String currentServerLabel() {
        ServerInfo server = mc == null ? null : mc.getCurrentServerEntry();
        return server == null ? "Unknown Server" : DiscordWebhookClient.formatServerAddress(server.address);
    }

    private String protectionServerLabel() {
        return safeValue(protectionTriggerServer).isEmpty() ? currentServerLabel() : protectionTriggerServer;
    }

    private String formatBlockPos(BlockPos pos) {
        if (pos == null) return "Unknown";
        return pos.getX() + ", " + pos.getY() + ", " + pos.getZ();
    }

    private String formatSpawnerPositions(List<BlockPos> positions, int limit) {
        if (positions == null || positions.isEmpty()) return "None visible";

        int safeLimit = Math.max(1, limit);
        StringBuilder sb = new StringBuilder();
        int count = Math.min(safeLimit, positions.size());
        for (int i = 0; i < count; i++) {
            if (i > 0) sb.append('\n');
            BlockPos pos = positions.get(i);
            sb.append(i + 1).append(". ").append(formatBlockPos(pos));
        }

        if (positions.size() > count) {
            sb.append('\n').append("+").append(positions.size() - count).append(" more");
        }
        return sb.toString();
    }

    private void sendModerationDisconnectWebhookAsync(String reason, boolean autoReconnectWasActive) {
        if (!webhook.get()) return;
        String url = webhookUrl.get().trim();
        if (url.isEmpty()) return;

        ModerationDisconnectDetails details = parseModerationDisconnect(reason);
        ServerInfo server = mc.getCurrentServerEntry();
        Vec3d pos = mc.player == null ? null : new Vec3d(mc.player.getX(), mc.player.getY(), mc.player.getZ());
        String type = details.ban() ? "Ban" : "Kick";

        List<DiscordWebhookClient.Field> fields = new ArrayList<>();
        fields.add(new DiscordWebhookClient.Field("Bot Account", botAccount(), true));
        fields.add(new DiscordWebhookClient.Field("Time", timeField(System.currentTimeMillis()), true));
        fields.add(new DiscordWebhookClient.Field("Type", type, true));
        fields.add(new DiscordWebhookClient.Field("Duration", details.duration(), true));
        fields.add(new DiscordWebhookClient.Field("Server", server == null ? "Unknown Server" : DiscordWebhookClient.formatServerAddress(server.address), true));
        fields.add(new DiscordWebhookClient.Field("Coordinates", formatVec3d(pos), true));
        fields.add(new DiscordWebhookClient.Field("Disconnected", "Yes", true));
        fields.add(new DiscordWebhookClient.Field("AutoReconnect", autoReconnectWasActive ? "Disabled" : "Already off", true));
        fields.add(new DiscordWebhookClient.Field("Module Active", isActive() ? "Yes" : "No", true));
        if (!details.banDate().isBlank()) fields.add(new DiscordWebhookClient.Field("Ban Date", details.banDate(), true));
        if (!details.banId().isBlank()) fields.add(new DiscordWebhookClient.Field("Ban ID", details.banId(), true));
        fields.add(new DiscordWebhookClient.Field("Reason", shorten(details.cleanReason(), 950), false));

        DiscordWebhookClient.sendEmbedAsync(url, buildPing(), "WProtect", "",
            "🚨 Bot Moderation Disconnect", "The bot was disconnected by a moderation/ban reason.",
            details.ban() ? 0xC90000 : 0xFF7A00,
            fields, "Sent by WProtect", "", Duration.ofSeconds(15));
    }

    private void sendWebhookAsync() {
        if (!webhook.get()) return;
        String url = webhookUrl.get().trim();
        if (url.isEmpty()) return;

        long ts = detectionTimeMs > 0 ? detectionTimeMs : System.currentTimeMillis();
        String player = detectedPlayer == null || detectedPlayer.isBlank() ? "Unknown" : detectedPlayer;
        String minedStatus = spawnersMinedSuccessfully ? "✅ Success" : "❌ Failed";
        int collected = actualCollectedSpawnerCount();

        List<DiscordWebhookClient.Field> fields = new ArrayList<>();
        fields.add(new DiscordWebhookClient.Field("Bot Account",        botAccount(),                     true));
        fields.add(new DiscordWebhookClient.Field("Time",               timeField(ts),                    true));
        fields.add(new DiscordWebhookClient.Field("Server",             protectionServerLabel(),          true));
        fields.add(new DiscordWebhookClient.Field("Bot Location",       formatBlockPos(protectionTriggerPos), true));
        fields.add(new DiscordWebhookClient.Field("Player Detected",    player,                           true));
        fields.add(new DiscordWebhookClient.Field("Spawners Collected", String.valueOf(collected), true));
        fields.add(new DiscordWebhookClient.Field("Spawners Mined",     minedStatus,                      true));
        fields.add(new DiscordWebhookClient.Field("Disconnected",       "Yes",                            true));
        if (emergencyTriggered && emergencyReason != null && !emergencyReason.isBlank()) {
            fields.add(new DiscordWebhookClient.Field("Reason", emergencyReason, false));
        }

        DiscordWebhookClient.sendEmbedAsync(url, buildPing(), "WProtect", "",
            "SpawnerProtect Alert", "Protection sequence completed on " + protectionServerLabel() + ".",
            emergencyTriggered ? 0xFF0000 : 0xFFD400,
            fields, "Sent by WProtect", "", Duration.ofSeconds(15));
    }

    private void sendSpecialCheckWebhookAsync(PlayerEntity player, SpecialCheck check) {
        if (!webhook.get() || player == null || check == null) return;
        String url = webhookUrl.get().trim();
        if (url.isEmpty()) return;

        BlockPos pos = player.getBlockPos();

        List<DiscordWebhookClient.Field> fields = new ArrayList<>();
        fields.add(new DiscordWebhookClient.Field("Bot Account",  botAccount(),                                        true));
        fields.add(new DiscordWebhookClient.Field("Time",         timeField(System.currentTimeMillis()),               true));
        fields.add(new DiscordWebhookClient.Field("Server",       currentServerLabel(),                                true));
        fields.add(new DiscordWebhookClient.Field("Check",        check.title,                                         true));
        fields.add(new DiscordWebhookClient.Field("Player Nick",  player.getName().getString(),                        true));
        fields.add(new DiscordWebhookClient.Field("Coordinates",  pos.getX() + ", " + pos.getY() + ", " + pos.getZ(), true));
        fields.add(new DiscordWebhookClient.Field("Disconnected", "No",                                                true));

        DiscordWebhookClient.sendEmbedAsync(url, buildPing(), "WProtect", "",
            "SpawnerProtect Check Alert", "Suspicious hidden-player check detected.",
            0xFF7A00, fields, "Sent by WProtect", "", Duration.ofSeconds(15));
    }

    private void sendTeleportWebhookAsync(net.minecraft.util.math.Vec3d from, net.minecraft.util.math.Vec3d to, double distance) {
        if (!webhook.get()) return;
        String url = webhookUrl.get().trim();
        if (url.isEmpty()) return;

        List<DiscordWebhookClient.Field> fields = new ArrayList<>();
        fields.add(new DiscordWebhookClient.Field("Bot Account",     botAccount(),                          true));
        fields.add(new DiscordWebhookClient.Field("Time",            timeField(System.currentTimeMillis()), true));
        fields.add(new DiscordWebhookClient.Field("Server",          currentServerLabel(),                  true));
        fields.add(new DiscordWebhookClient.Field("Old Coordinates", formatVec3d(from),                  true));
        fields.add(new DiscordWebhookClient.Field("New Coordinates", formatVec3d(to),                    true));
        fields.add(new DiscordWebhookClient.Field("Distance",        String.format("%.1f blocks", distance), true));
        fields.add(new DiscordWebhookClient.Field("Disconnected",    "No",                                  true));

        DiscordWebhookClient.sendEmbedAsync(url, buildPing(), "WProtect", "",
            "🚨 Sudden Teleport Alert", "The bot was suddenly teleported (possible admin tp).",
            0xFF0000, fields, "Sent by WProtect", "", Duration.ofSeconds(15));
    }

    private void startMaintenanceHomeRecoveryAfterTeleport(double distance) {
        MaintenanceHomeRecoveryModule maintenanceHomeRecovery = Modules.get().get(MaintenanceHomeRecoveryModule.class);
        if (maintenanceHomeRecovery == null || !maintenanceHomeRecovery.isActive()) return;
        maintenanceHomeRecovery.startHomeRecoveryAfterSuddenTeleport(distance);
    }

    private void sendAfkTeleportWebhookAsync(String message) {
        if (!webhook.get()) return;
        String url = webhookUrl.get().trim();
        if (url.isEmpty()) return;

        if (!DiscordWebhookClient.allowDedup("spawner-protect-afk-teleport", AFK_TELEPORT_ALERT_DEDUP_MS)) return;

        ServerInfo server = mc.getCurrentServerEntry();
        Vec3d pos = mc.player == null ? null : new Vec3d(mc.player.getX(), mc.player.getY(), mc.player.getZ());

        List<DiscordWebhookClient.Field> fields = new ArrayList<>();
        fields.add(new DiscordWebhookClient.Field("Bot Account",  botAccount(),                          true));
        fields.add(new DiscordWebhookClient.Field("Time",         timeField(System.currentTimeMillis()), true));
        fields.add(new DiscordWebhookClient.Field("Server",       server == null ? "Unknown Server" : DiscordWebhookClient.formatServerAddress(server.address), true));
        fields.add(new DiscordWebhookClient.Field("Coordinates",  formatVec3d(pos),                      true));
        fields.add(new DiscordWebhookClient.Field("Disconnected", "No",                                  true));
        fields.add(new DiscordWebhookClient.Field("Chat Message", shorten(safeValue(message), 950),       false));

        DiscordWebhookClient.sendEmbedAsync(url, buildPing(), "WProtect", "",
            "🚨 AFK Teleport Alert", "The bot received an AFK teleport message.",
            0xFF7A00, fields, "Sent by WProtect", "", Duration.ofSeconds(15));
    }

    private String formatVec3d(net.minecraft.util.math.Vec3d vec) {
        if (vec == null) return "Unknown";
        return String.format("%.1f, %.1f, %.1f", vec.x, vec.y, vec.z);
    }

    private boolean isModerationDisconnect(String reasonRaw) {
        String reason = normalizeForMatch(reasonRaw);
        if (reason.isEmpty()) return false;
        return isBanReason(reason)
            || reason.contains("kick")
            || reason.contains("kicked")
            || reason.contains("кик")
            || reason.contains("выгнан")
            || reason.contains("removed by an operator")
            || reason.contains("disconnect by admin");
    }

    private boolean isAfkTeleportMessage(String messageRaw) {
        String message = normalizeForMatch(messageRaw);
        return !message.isEmpty() && message.contains(AFK_TELEPORT_MARKER);
    }

    private boolean isBanReason(String reasonRaw) {
        String reason = normalizeForMatch(reasonRaw);
        return reason.contains("ban")
            || reason.contains("banned")
            || reason.contains("blacklist")
            || reason.contains("blocked")
            || reason.contains("suspended")
            || reason.contains("бан")
            || reason.contains("забан")
            || reason.contains("заблок")
            || reason.contains("черн")
            || reason.contains("перманент");
    }

    private boolean isOwnProtectionDisconnect(String reasonRaw) {
        String reason = normalizeForMatch(reasonRaw);
        return reason.contains("wprotect disconnect")
            || reason.contains("spawnerprotect")
            || reason.contains("spawner protect");
    }

    private ModerationDisconnectDetails parseModerationDisconnect(String reasonRaw) {
        String raw = stripMinecraftFormatting(safeValue(reasonRaw));
        String banDate = "";
        String banId = "";
        List<String> reasonLines = new ArrayList<>();

        for (String rawLine : raw.split("\\R+")) {
            String line = rawLine == null ? "" : rawLine.trim();
            if (line.isEmpty()) continue;

            Matcher dateMatcher = BAN_DATE_LINE_PATTERN.matcher(line);
            if (dateMatcher.matches()) {
                banDate = dateMatcher.group(1).trim();
                continue;
            }

            Matcher idMatcher = BAN_ID_LINE_PATTERN.matcher(line);
            if (idMatcher.matches()) {
                banId = idMatcher.group(1).trim();
                continue;
            }

            String normalized = normalizeForMatch(line);
            if (normalized.equals("connection lost")
                || normalized.contains("you may be able to appeal")
                || normalized.contains("appeal this ban")
                || normalized.contains("discord.gg/")) {
                continue;
            }

            reasonLines.add(line);
        }

        String cleanReason = String.join("\n", reasonLines).trim();
        if (cleanReason.isBlank()) cleanReason = raw.isBlank() ? "Unknown" : raw;

        boolean ban = isBanReason(raw) || !banId.isBlank() || !banDate.isBlank();
        String duration = ban ? (!banDate.isBlank() ? "Until " + banDate : extractBanDuration(cleanReason)) : "N/A";
        if (ban && duration.equals("Unknown") && banDate.isBlank()) duration = "Permanent";

        return new ModerationDisconnectDetails(cleanReason, duration, banDate, banId, ban);
    }

    private static String stripMinecraftFormatting(String value) {
        if (value == null || value.isEmpty()) return "";
        return MC_FORMATTING_CODE_PATTERN.matcher(value).replaceAll("");
    }

    private String extractBanDuration(String reasonRaw) {
        String reason = safeValue(reasonRaw);
        String normalized = normalizeForMatch(reason);
        if (normalized.contains("permanent")
            || normalized.contains("permaban")
            || normalized.contains("forever")
            || normalized.contains("навсегда")
            || normalized.contains("перманент")) {
            return "Permanent";
        }

        Matcher matcher = BAN_DURATION_PATTERN.matcher(reason);
        List<String> parts = new ArrayList<>();
        while (matcher.find() && parts.size() < 3) {
            parts.add(matcher.group().trim());
        }
        return parts.isEmpty() ? "Unknown" : String.join(" ", parts);
    }

    private static String textToPlainString(Text text) {
        if (text == null) return "";
        try {
            return text.getString();
        } catch (Exception ignored) {
            return "";
        }
    }

    private static String normalizeForMatch(String value) {
        return safeValue(value).toLowerCase(Locale.ROOT);
    }

    private static String safeValue(String value) {
        return value == null ? "" : value.trim();
    }

    private static String shorten(String value, int maxLen) {
        if (value == null) return "";
        if (maxLen <= 0 || value.length() <= maxLen) return value;
        return value.substring(0, maxLen) + "...";
    }

    private void sendSuddenDisappearanceWebhookAsync(BlockPos pos) {
        if (!webhook.get()) return;
        String url = webhookUrl.get().trim();
        if (url.isEmpty()) return;
        String dedupKey = "spawner-disappearance:" + normalizeForMatch(currentServerLabel()) + ":" + pos.getX() + ":" + pos.getY() + ":" + pos.getZ();
        if (!DiscordWebhookClient.allowDedup(dedupKey, SPAWNER_DISAPPEAR_ALERT_DEDUP_MS)) return;

        List<DiscordWebhookClient.Field> fields = new ArrayList<>();
        fields.add(new DiscordWebhookClient.Field("Bot Account",      botAccount(),                                        true));
        fields.add(new DiscordWebhookClient.Field("Time",             timeField(System.currentTimeMillis()),               true));
        fields.add(new DiscordWebhookClient.Field("Server",           currentServerLabel(),                                true));
        fields.add(new DiscordWebhookClient.Field("Spawner Location", pos.getX() + ", " + pos.getY() + ", " + pos.getZ(), true));
        fields.add(new DiscordWebhookClient.Field("Disconnected",     "No",                                                true));

        DiscordWebhookClient.sendEmbedAsync(url, buildPing(), "WProtect", "",
            "🚨 Spawner Disappearance Alert", "A nearby spawner suddenly disappeared (possibly broken by another player or //replacenear).",
            0xFF7A00, fields, "Sent by WProtect", "", Duration.ofSeconds(15));
    }

    private void monitorSpawnerDisappearances() {
        long nowMs = System.currentTimeMillis();
        if (nowMs < nextDisappearanceScanAtMs) return;
        nextDisappearanceScanAtMs = nowMs + Math.max(1000L, activationScanIntervalMs.get());
        if (!isActive() || mc.player == null || mc.world == null) return;
        if (state != State.IDLE) return;
        if (isDisappearanceAlertSuppressed()) {
            observedSpawners.clear();
            pendingDisappearances.clear();
            return;
        }

        int range = Math.min(Math.max(1, scanRange.get()), 16);
        double rangeSq = range * range;
        BlockPos origin = mc.player.getBlockPos();
        Set<BlockPos> currentlyVisible = new HashSet<>();

        for (BlockPos mutable : BlockPos.iterate(
            origin.add(-range, -range, -range),
            origin.add(range, range, range)
        )) {
            if (!isRealSpawner(mutable)) continue;
            BlockPos pos = mutable.toImmutable();
            currentlyVisible.add(pos);
            observedSpawners.putIfAbsent(pos, nowMs);
            pendingDisappearances.remove(pos);
        }

        Iterator<Map.Entry<BlockPos, Long>> iterator = observedSpawners.entrySet().iterator();
        while (iterator.hasNext()) {
            Map.Entry<BlockPos, Long> entry = iterator.next();
            BlockPos pos = entry.getKey();
            if (currentlyVisible.contains(pos)) continue;

            if (pos.getSquaredDistance(origin) > rangeSq) {
                iterator.remove();
                continue;
            }

            if (isRealSpawner(pos)) {
                currentlyVisible.add(pos);
                continue;
            }

            long trackedAgeMs = Math.max(0L, nowMs - entry.getValue());
            pendingDisappearances.putIfAbsent(pos, nowMs);
            if (nowMs - pendingDisappearances.getOrDefault(pos, nowMs) >= DISAPPEAR_CONFIRM_MS) {
                iterator.remove();
                pendingDisappearances.remove(pos);
                handleSpawnerDisappearance(pos, trackedAgeMs);
            }
        }

        pendingDisappearances.keySet().removeIf(pos -> pos.getSquaredDistance(origin) > rangeSq);
    }

    private void handleSpawnerDisappearance(BlockPos pos, long trackedAgeMs) {
        if (!isActive() || pos == null || mc.player == null) return;
        if (state != State.IDLE) return;
        if (isDisappearanceAlertSuppressed()) return;
        if (mc.player.squaredDistanceTo(net.minecraft.util.math.Vec3d.ofCenter(pos)) > scanRange.get() * scanRange.get()) return;

        long minAgeMs = Math.max(0L, spawnerDisappearMinAgeSeconds.get()) * 1000L;
        if (trackedAgeMs < minAgeMs) return;

        warning("Spawner at " + pos.toShortString() + " suddenly disappeared! Notifying via webhook.");
        sendSuddenDisappearanceWebhookAsync(pos);
    }

    private boolean isDisappearanceAlertSuppressed() {
        return System.currentTimeMillis() < suppressDisappearAlertsUntilMs;
    }
}
