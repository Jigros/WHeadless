package com.nnpg.wspawnerprotect.modules;

import com.nnpg.wspawnerprotect.WSpawnerProtectAddon;
import com.nnpg.wspawnerprotect.compat.meteorclient.events.game.ReceiveMessageEvent;
import com.nnpg.wspawnerprotect.compat.meteorclient.events.world.TickEvent;
import com.nnpg.wspawnerprotect.compat.meteorclient.settings.BoolSetting;
import com.nnpg.wspawnerprotect.compat.meteorclient.settings.IntSetting;
import com.nnpg.wspawnerprotect.compat.meteorclient.settings.Setting;
import com.nnpg.wspawnerprotect.compat.meteorclient.settings.SettingGroup;
import com.nnpg.wspawnerprotect.compat.meteorclient.settings.StringSetting;
import com.nnpg.wspawnerprotect.compat.meteorclient.systems.modules.Module;
import com.nnpg.wspawnerprotect.compat.meteorclient.systems.modules.Modules;
import com.nnpg.wspawnerprotect.compat.meteorclient.utils.player.ChatUtils;
import com.nnpg.wspawnerprotect.compat.orbit.EventHandler;
import com.nnpg.wspawnerprotect.util.DiscordWebhookClient;
import com.nnpg.wspawnerprotect.util.SpawnerBlockUtil;
import net.minecraft.util.math.BlockPos;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ThreadLocalRandom;

public final class MaintenanceHomeRecoveryModule extends Module {
    private static final String HOME_SUCCESS_MARKER = "you teleported to your home";
    private static final String HUGO_HOME_SUCCESS_MARKER = "you were teleported to your home";
    private static final String MAINTENANCE_MARKER = "connecting to an area in maintenance";
    private static final String PROXY_LIMBO_MARKER = "proxy limbo";
    private static final String SERVER_RESTARTING_MARKER = "server is restarting";
    private static final String SERVER_UPDATING_MARKER = "servers are updating, do not teleport";
    private static final String SERVER_RETURNING_MARKER = "your region started back up";
    private static final long MAINTENANCE_WEBHOOK_DEDUP_MS = 60_000L;
    private static final long HOME_SUCCESS_TELEPORT_SUPPRESS_MS = 30_000L;
    private static final long SERVER_RETURN_STABLE_SPAWNERS_MS = 5_000L;

    private enum State {
        MONITORING,
        DELAY_BEFORE_HOME,
        WAIT_HOME_RESULT,
        WAIT_SERVER_RETURN
    }

    private final SettingGroup sgGeneral = settings.getDefaultGroup();
    private final SettingGroup sgWebhook = settings.createGroup("Webhook");

    private final Setting<Boolean> notifications = sgGeneral.add(new BoolSetting.Builder()
        .name("notifications")
        .description("Show essential local status messages for the maintenance recovery flow.")
        .defaultValue(true)
        .build()
    );

    private final Setting<Boolean> autoEnableOnJoin = sgGeneral.add(new BoolSetting.Builder()
        .name("auto-enable-on-join")
        .description("Automatically enable MaintenanceHomeRecovery when joining a server.")
        .defaultValue(false)
        .build()
    );

    private final Setting<Integer> spawnerCheckRange = sgGeneral.add(new IntSetting.Builder()
        .name("spawner-check-range")
        .description("Range used to decide whether spawners are still nearby.")
        .defaultValue(4)
        .min(1)
        .sliderMax(24)
        .build()
    );

    private final Setting<Integer> noSpawnerSeconds = sgGeneral.add(new IntSetting.Builder()
        .name("no-spawner-seconds")
        .description("How long spawners must be missing before /home recovery starts.")
        .defaultValue(30)
        .min(1)
        .sliderMax(300)
        .build()
    );

    private final Setting<Boolean> recoverAfterSuddenTeleport = sgGeneral.add(new BoolSetting.Builder()
        .name("recover-after-sudden-teleport")
        .description("Start /home recovery when SpawnerProtect detects a sudden teleport.")
        .defaultValue(true)
        .build()
    );

    private final Setting<String> homeCommand = sgGeneral.add(new StringSetting.Builder()
        .name("home-command")
        .description("Command used to return home.")
        .defaultValue("/home 1")
        .build()
    );

    private final Setting<Integer> firstHomeDelaySeconds = sgGeneral.add(new IntSetting.Builder()
        .name("first-home-delay-seconds")
        .description("Delay before the first /home command after spawners disappear.")
        .defaultValue(2)
        .min(0)
        .sliderMax(60)
        .build()
    );

    private final Setting<Integer> proxyLimboPauseSeconds = sgGeneral.add(new IntSetting.Builder()
        .name("proxy-limbo-pause-seconds")
        .description("How long to suppress /home recovery after proxy limbo/restart chat.")
        .defaultValue(90)
        .min(10)
        .sliderMax(300)
        .build()
    );

    private final Setting<Integer> retryStartMinutes = sgGeneral.add(new IntSetting.Builder()
        .name("retry-start-minutes")
        .description("Delay in minutes before the first /home retry after maintenance is detected.")
        .defaultValue(5)
        .min(1)
        .sliderMax(60)
        .build()
    );

    private final Setting<Integer> retryRandomStepMinutes = sgGeneral.add(new IntSetting.Builder()
        .name("retry-random-step-minutes")
        .description("Maximum random minutes added to each next /home retry delay.")
        .defaultValue(3)
        .min(1)
        .sliderMax(30)
        .build()
    );

    private final Setting<Integer> retryMaxMinutes = sgGeneral.add(new IntSetting.Builder()
        .name("retry-max-minutes")
        .description("Maximum delay in minutes between /home retries while maintenance is active.")
        .defaultValue(30)
        .min(1)
        .sliderMax(180)
        .build()
    );

    private final Setting<Integer> commandWaitSeconds = sgGeneral.add(new IntSetting.Builder()
        .name("command-wait-seconds")
        .description("Seconds to wait for maintenance or home success chat after sending /home.")
        .defaultValue(8)
        .min(1)
        .sliderMax(60)
        .build()
    );

    private final Setting<Boolean> webhook = sgWebhook.add(new BoolSetting.Builder()
        .name("webhook")
        .description("Send Discord webhook notifications for maintenance recovery.")
        .defaultValue(false)
        .build()
    );

    private final Setting<String> webhookUrl = sgWebhook.add(new StringSetting.Builder()
        .name("webhook-url")
        .description("Discord webhook URL.")
        .defaultValue("")
        .visible(webhook::get)
        .build()
    );

    private final Setting<Boolean> selfPing = sgWebhook.add(new BoolSetting.Builder()
        .name("self-ping")
        .description("Ping your Discord account in webhook.")
        .defaultValue(false)
        .visible(webhook::get)
        .build()
    );

    private final Setting<String> discordId = sgWebhook.add(new StringSetting.Builder()
        .name("discord-id")
        .description("Discord numeric user id.")
        .defaultValue("")
        .visible(() -> webhook.get() && selfPing.get())
        .build()
    );

    private State state = State.MONITORING;
    private long noSpawnerSinceMs;
    private long actionAtMs;
    private long maintenanceStartedAtMs;
    private long proxyLimboSuppressUntilMs;
    private long serverReturnVisibleSinceMs;
    private int currentRetryHomeMinutes;
    private String lastMaintenanceMessage = "";
    private boolean serverReturnSawNoSpawners;

    public MaintenanceHomeRecoveryModule() {
        super(WSpawnerProtectAddon.CATEGORY, "maintenance-home-recovery", "When spawners disappear and /home hits maintenance, keeps retrying /home until home succeeds and reports it to Discord.");
        this.chatFeedback = false;
    }

    public boolean shouldAutoEnableOnServerJoin() {
        return autoEnableOnJoin.get();
    }

    public void startHomeRecoveryAfterSuddenTeleport(double distance) {
        if (!recoverAfterSuddenTeleport.get()) return;
        if (mc.player == null || mc.world == null) return;
        if (state == State.WAIT_SERVER_RETURN) {
            suppressSpawnerProtectTeleportAlert();
            notifyUser("Server is returning the player automatically; ignoring sudden teleport recovery trigger.");
            return;
        }

        noSpawnerSinceMs = 0L;
        state = State.DELAY_BEFORE_HOME;
        actionAtMs = System.currentTimeMillis() + Math.max(0, firstHomeDelaySeconds.get()) * 1000L;
        notifyUser("Sudden teleport detected (" + String.format(Locale.ROOT, "%.1f", distance) + " blocks). Trying " + normalizedCommand(homeCommand.get()) + ".");
    }

    @Override
    public void onActivate() {
        resetFlow();
        notifyUser("Activated.");
    }

    @Override
    public void onDeactivate() {
        resetFlow();
        notifyUser("Deactivated.");
    }

    @EventHandler
    private void onReceiveMessage(ReceiveMessageEvent event) {
        if (event == null || event.getMessage() == null) return;
        String message = event.getMessage().getString();
        if (message == null || message.isBlank()) return;

        String lower = message.toLowerCase(Locale.ROOT);
        if (isProxyLimboMessage(lower)) {
            handleProxyLimboMessage(message);
            return;
        }

        if (lower.contains(SERVER_RETURNING_MARKER)) {
            handleServerReturningMessage(message);
            return;
        }

        if (lower.contains(SERVER_UPDATING_MARKER)) {
            handleServerUpdatingMessage(message);
            return;
        }

        if (lower.contains(MAINTENANCE_MARKER)) {
            handleMaintenanceMessage(message);
            return;
        }

        if (isHomeSuccessMessage(lower)) {
            handleHomeSuccess(message);
        }
    }

    @EventHandler
    private void onTick(TickEvent.Pre event) {
        if (mc.player == null || mc.world == null) return;

        long nowMs = System.currentTimeMillis();
        switch (state) {
            case MONITORING -> tickMonitoring(nowMs);
            case DELAY_BEFORE_HOME -> {
                if (isProxyLimboSuppressed(nowMs)) return;
                if (nowMs >= actionAtMs) tryHomeTeleport();
            }
            case WAIT_HOME_RESULT -> {
                if (nowMs >= actionAtMs) scheduleHomeRetry();
            }
            case WAIT_SERVER_RETURN -> tickServerReturnWait(nowMs);
        }
    }

    @Override
    public String getInfoString() {
        long nowMs = System.currentTimeMillis();
        return switch (state) {
            case MONITORING -> noSpawnerSinceMs <= 0L ? "Monitoring" : "No spawners " + Math.max(0L, (nowMs - noSpawnerSinceMs) / 1000L) + "s";
            case DELAY_BEFORE_HOME -> "Home in " + Math.max(0L, (actionAtMs - nowMs + 999L) / 1000L) + "s";
            case WAIT_HOME_RESULT -> maintenanceStartedAtMs > 0L ? "Maintenance " + formatDuration(nowMs - maintenanceStartedAtMs) : "Waiting /home";
            case WAIT_SERVER_RETURN -> maintenanceStartedAtMs > 0L ? "Server update " + formatDuration(nowMs - maintenanceStartedAtMs) : "Server update";
        };
    }

    private void tickMonitoring(long nowMs) {
        if (isProxyLimboSuppressed(nowMs)) {
            noSpawnerSinceMs = 0L;
            return;
        }

        if (hasNearbySpawner(spawnerCheckRange.get())) {
            noSpawnerSinceMs = 0L;
            return;
        }

        if (noSpawnerSinceMs <= 0L) {
            noSpawnerSinceMs = nowMs;
            return;
        }

        if (nowMs - noSpawnerSinceMs < noSpawnerSeconds.get() * 1000L) return;

        state = State.DELAY_BEFORE_HOME;
        actionAtMs = nowMs + Math.max(0, firstHomeDelaySeconds.get()) * 1000L;
        notifyUser("No nearby spawners for " + noSpawnerSeconds.get() + "s. Starting " + normalizedCommand(homeCommand.get()) + " recovery.");
    }

    private void tryHomeTeleport() {
        if (!safeSendChatCommand(homeCommand.get())) {
            scheduleHomeRetry();
            return;
        }

        state = State.WAIT_HOME_RESULT;
        actionAtMs = System.currentTimeMillis() + commandWaitSeconds.get() * 1000L;
        notifyUser("Sent " + normalizedCommand(homeCommand.get()) + ", waiting for maintenance or home success chat.");
    }

    private void handleProxyLimboMessage(String message) {
        long nowMs = System.currentTimeMillis();
        lastMaintenanceMessage = message;
        proxyLimboSuppressUntilMs = 0L;

        if (maintenanceStartedAtMs <= 0L) {
            maintenanceStartedAtMs = nowMs;
            sendMaintenanceWebhookAsync(message, true);
        }

        state = State.DELAY_BEFORE_HOME;
        actionAtMs = nowMs + Math.max(0, firstHomeDelaySeconds.get()) * 1000L;
        noSpawnerSinceMs = 0L;
        serverReturnVisibleSinceMs = 0L;
        serverReturnSawNoSpawners = true;
        suppressSpawnerProtectTeleportAlert();

        notifyUser("Proxy limbo/restart chat detected. Sending " + normalizedCommand(homeCommand.get()) + " in " + Math.max(0, firstHomeDelaySeconds.get()) + "s.");
    }

    private void handleMaintenanceMessage(String message) {
        lastMaintenanceMessage = message;
        if (state == State.WAIT_SERVER_RETURN) {
            if (maintenanceStartedAtMs <= 0L) {
                maintenanceStartedAtMs = System.currentTimeMillis();
                sendMaintenanceWebhookAsync(message, true);
            }
            noSpawnerSinceMs = 0L;
            actionAtMs = 0L;
            notifyUser("Maintenance message received during server return. Still waiting for automatic teleport; not sending " + normalizedCommand(homeCommand.get()) + ".");
            return;
        }

        if (maintenanceStartedAtMs <= 0L) {
            maintenanceStartedAtMs = System.currentTimeMillis();
            notifyUser("Maintenance message detected. Retrying " + normalizedCommand(homeCommand.get()) + " until home succeeds.");
            sendMaintenanceWebhookAsync(message, false);
        }
        scheduleHomeRetry();
    }

    private void handleServerUpdatingMessage(String message) {
        // DonutSMP warns not to teleport on this line; wait for explicit proxy-limbo chat.
    }
    private void handleServerReturningMessage(String message) {
        lastMaintenanceMessage = message;
        if (maintenanceStartedAtMs <= 0L) {
            maintenanceStartedAtMs = System.currentTimeMillis();
            sendMaintenanceWebhookAsync(message, true);
        }

        state = State.WAIT_SERVER_RETURN;
        actionAtMs = 0L;
        noSpawnerSinceMs = 0L;
        serverReturnVisibleSinceMs = 0L;
        serverReturnSawNoSpawners = !hasNearbySpawner(spawnerCheckRange.get());
        suppressSpawnerProtectTeleportAlert();
        notifyUser("Server return message detected. Waiting for automatic teleport; not sending " + normalizedCommand(homeCommand.get()) + ".");
    }

    private void handleHomeSuccess(String message) {
        boolean wasRecovering = state != State.MONITORING || maintenanceStartedAtMs > 0L;
        if (wasRecovering) suppressSpawnerProtectTeleportAlert();

        if (state == State.WAIT_SERVER_RETURN) {
            serverReturnSawNoSpawners = true;
            serverReturnVisibleSinceMs = 0L;
            notifyUser("Home teleport message received during server return. Waiting for nearby spawners before finishing recovery.");
            return;
        }

        if (maintenanceStartedAtMs > 0L) {
            sendRecoverySuccessWebhookAsync(message);
            notifyUser("Home teleport confirmed after " + formatDuration(System.currentTimeMillis() - maintenanceStartedAtMs) + ".");
        }
        resetFlow();
    }

    private boolean isHomeSuccessMessage(String lowerMessage) {
        return lowerMessage.contains(HOME_SUCCESS_MARKER)
            || lowerMessage.contains(HUGO_HOME_SUCCESS_MARKER);
    }

    private void tickServerReturnWait(long nowMs) {
        boolean hasSpawners = hasNearbySpawner(spawnerCheckRange.get());
        if (!hasSpawners) {
            serverReturnSawNoSpawners = true;
            serverReturnVisibleSinceMs = 0L;
            return;
        }

        if (!serverReturnSawNoSpawners) return;

        if (serverReturnVisibleSinceMs <= 0L) {
            serverReturnVisibleSinceMs = nowMs;
            return;
        }

        if (nowMs - serverReturnVisibleSinceMs < SERVER_RETURN_STABLE_SPAWNERS_MS) return;

        String message = "Nearby spawners are visible again after server update.";
        suppressSpawnerProtectTeleportAlert();
        if (maintenanceStartedAtMs > 0L) {
            sendRecoverySuccessWebhookAsync(message);
            notifyUser("Server returned the player after " + formatDuration(nowMs - maintenanceStartedAtMs) + ".");
        }
        resetFlow();
    }

    private void suppressSpawnerProtectTeleportAlert() {
        SpawnerProtectModule spawnerProtect = Modules.get().get(SpawnerProtectModule.class);
        if (spawnerProtect == null) return;
        spawnerProtect.suppressTeleportAlertsFor(HOME_SUCCESS_TELEPORT_SUPPRESS_MS);
    }

    private void scheduleHomeRetry() {
        int minutes = nextRetryHomeMinutes();
        state = State.DELAY_BEFORE_HOME;
        actionAtMs = System.currentTimeMillis() + minutes * 60_000L;
        notifyUser("Next " + normalizedCommand(homeCommand.get()) + " retry in " + minutes + " minute(s).");
    }

    private int nextRetryHomeMinutes() {
        int start = Math.max(1, retryStartMinutes.get());
        int max = Math.max(start, retryMaxMinutes.get());

        int next;
        if (currentRetryHomeMinutes <= 0) {
            next = start;
        } else if (currentRetryHomeMinutes >= max) {
            int maxStep = Math.max(1, retryRandomStepMinutes.get());
            int minAtCap = Math.max(start, max - maxStep);
            next = ThreadLocalRandom.current().nextInt(minAtCap, max + 1);
            if (minAtCap < max && next == currentRetryHomeMinutes) {
                next = next >= max ? minAtCap : next + 1;
            }
        } else {
            int maxStep = Math.max(1, retryRandomStepMinutes.get());
            int step = ThreadLocalRandom.current().nextInt(1, maxStep + 1);
            next = Math.min(max, currentRetryHomeMinutes + step);
        }

        currentRetryHomeMinutes = next;
        return next;
    }

    private boolean safeSendChatCommand(String command) {
        if (mc.player == null || mc.getNetworkHandler() == null) return false;
        String normalized = normalizedCommand(command);
        if (normalized.isEmpty()) return false;

        try {
            ChatUtils.sendPlayerMsg(normalized);
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    private String normalizedCommand(String command) {
        return command == null ? "" : command.trim();
    }

    private boolean isProxyLimboSuppressed(long nowMs) {
        return nowMs < proxyLimboSuppressUntilMs;
    }

    private boolean isProxyLimboMessage(String lowerMessage) {
        if (lowerMessage == null || lowerMessage.isBlank()) return false;
        return lowerMessage.contains(PROXY_LIMBO_MARKER)
            || (lowerMessage.contains(SERVER_RESTARTING_MARKER) && lowerMessage.contains("limbo"));
    }

    private boolean hasNearbySpawner(int range) {
        if (mc.player == null || mc.world == null) return false;

        BlockPos origin = mc.player.getBlockPos();
        int scanRange = Math.max(1, range);
        for (BlockPos pos : BlockPos.iterate(
            origin.add(-scanRange, -scanRange, -scanRange),
            origin.add(scanRange, scanRange, scanRange)
        )) {
            if (SpawnerBlockUtil.isRealSpawner(mc.world, pos)) return true;
        }

        return false;
    }

    private void sendMaintenanceWebhookAsync(String message, boolean serverUpdating) {
        if (!webhook.get()) return;
        String url = webhookUrl.get().trim();
        if (url.isEmpty()) return;

        String dedupKey = (serverUpdating ? "maintenance-home-recovery-server-updating-" : "maintenance-home-recovery-start-") + botAccount();
        if (!DiscordWebhookClient.allowDedup(dedupKey, MAINTENANCE_WEBHOOK_DEDUP_MS)) return;

        List<DiscordWebhookClient.Field> fields = new ArrayList<>();
        fields.add(new DiscordWebhookClient.Field("Bot Account", botAccount(), true));
        fields.add(new DiscordWebhookClient.Field("Server", currentServerLabel(), true));
        fields.add(new DiscordWebhookClient.Field("Time", timeField(maintenanceStartedAtMs), true));
        fields.add(new DiscordWebhookClient.Field("Chat Message", shorten(message, 950), false));

        DiscordWebhookClient.sendEmbedAsync(url, buildPing(), "WProtect", "",
            "🚧 Maintenance Detected",
            serverUpdating ? "Server is updating; waiting for automatic return." : "Home area is currently in maintenance.",
            0xFF7A00, fields, "Sent by WProtect", "", Duration.ofSeconds(15));
    }

    private void sendRecoverySuccessWebhookAsync(String message) {
        if (!webhook.get()) return;
        String url = webhookUrl.get().trim();
        if (url.isEmpty()) return;

        long nowMs = System.currentTimeMillis();
        List<DiscordWebhookClient.Field> fields = new ArrayList<>();
        fields.add(new DiscordWebhookClient.Field("Bot Account", botAccount(), true));
        fields.add(new DiscordWebhookClient.Field("Server", currentServerLabel(), true));
        fields.add(new DiscordWebhookClient.Field("Maintenance Started", timeField(maintenanceStartedAtMs), true));
        fields.add(new DiscordWebhookClient.Field("Recovered At", timeField(nowMs), true));
        fields.add(new DiscordWebhookClient.Field("Wait Time", formatDuration(nowMs - maintenanceStartedAtMs), true));
        if (!lastMaintenanceMessage.isBlank()) fields.add(new DiscordWebhookClient.Field("Maintenance Message", shorten(lastMaintenanceMessage, 950), false));
        fields.add(new DiscordWebhookClient.Field("Success Message", shorten(message, 950), false));

        DiscordWebhookClient.sendEmbedAsync(url, buildPing(), "WProtect", "",
            "✅ Server Reachable", "Home teleport succeeded after maintenance.",
            0x22C55E, fields, "Sent by WProtect", "", Duration.ofSeconds(15));
    }

    private String currentServerLabel() {
        return mc.getCurrentServerEntry() == null
            ? "Unknown Server"
            : DiscordWebhookClient.formatServerAddress(mc.getCurrentServerEntry().address);
    }

    private String buildPing() {
        return selfPing.get() && !discordId.get().trim().isEmpty() ? "<@" + discordId.get().trim() + ">" : "";
    }

    private String botAccount() {
        return mc.getSession() != null ? mc.getSession().getUsername() : "Unknown";
    }

    private static String timeField(long epochMs) {
        return "<t:" + (epochMs / 1000L) + ":R>";
    }

    private static String formatDuration(long durationMs) {
        long seconds = Math.max(0L, durationMs / 1000L);
        long minutes = seconds / 60L;
        long hours = minutes / 60L;
        seconds %= 60L;
        minutes %= 60L;

        if (hours > 0L) return hours + "h " + minutes + "m " + seconds + "s";
        if (minutes > 0L) return minutes + "m " + seconds + "s";
        return seconds + "s";
    }

    private static String safeValue(String value) {
        return value == null ? "" : value.trim();
    }

    private static String shorten(String value, int maxLen) {
        String safe = safeValue(value);
        if (maxLen <= 0 || safe.length() <= maxLen) return safe;
        return safe.substring(0, maxLen) + "...";
    }

    private void resetFlow() {
        state = State.MONITORING;
        noSpawnerSinceMs = 0L;
        actionAtMs = 0L;
        maintenanceStartedAtMs = 0L;
        proxyLimboSuppressUntilMs = 0L;
        serverReturnVisibleSinceMs = 0L;
        currentRetryHomeMinutes = 0;
        lastMaintenanceMessage = "";
        serverReturnSawNoSpawners = false;
    }

    private void notifyUser(String message) {
        if (!notifications.get()) return;
        ChatUtils.info("[MaintenanceHomeRecovery] " + message);
    }
}
