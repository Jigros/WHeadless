const mineflayer = require('mineflayer');
const { SocksProxyAgent } = require('socks-proxy-agent');

console.log("Starting minimal test...");

// Данные прокси из вашего config.json
const proxyUrl = 'socks5://batcoh988:JuLhiocf2t@151.244.79.239:50101';
const agent = new SocksProxyAgent(proxyUrl);

const bot = mineflayer.createBot({
  host: 'donutsmp.net',
  port: 25565,
  version: '1.21.1',
  username: 'batcohwm7@outlook.com',
  auth: 'microsoft',
  profilesFolder: './auth/profiles',
  agent: agent
});

bot.once('spawn', () => {
  console.log('[Bot] Успешно зашел на сервер и заспавнился!');
  
  // Патч, чтобы бот не крашился из-за бага 1.21 (enchantments.concat is not a function)
  const origDigTime = bot.digTime.bind(bot);
  bot.digTime = (block) => {
    try {
      return origDigTime(block);
    } catch (e) {
      // Если происходит краш из-за чар на топоре, возвращаем стандартное время (например, 200мс)
      return 200;
    }
  };

  // Начинаем бесконечный цикл копания
  startDiggingLoop();
});

bot.on('error', (err) => console.log('[Error]', err));
bot.on('kicked', (reason) => console.log('[Kicked]', reason));

async function startDiggingLoop() {
  console.log('[Bot] Запускаю ванильный цикл копания...');
  
  while (true) {
    // Пауза между проверками/ударами (300 мс)
    await new Promise(resolve => setTimeout(resolve, 300));
    
    if (!bot.entity) continue;
    
    // Ищем сундук в радиусе 5 блоков
    const chest = bot.findBlock({
      matching: (block) => block.name.includes('chest') || block.name.includes('barrel') || block.name.includes('hopper'),
      maxDistance: 5
    });

    if (!chest) {
      console.log('[Bot] Не вижу сундук поблизости. Жду 2 секунды...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      continue;
    }

    try {
      // Если бот еще ничего не копает, просим его вскопать сундук (без резкого поворота головы)
      if (!bot.targetDigging) {
        console.log(`[Bot] Начинаю копать сундук на координатах ${chest.position}...`);
        await bot.dig(chest, false, 'raycast');
        console.log('[Bot] Успешно завершил цикл копания.');
      }
    } catch (err) {
      if (err.message === 'Digging aborted') {
        console.log('[Bot] Копание было прервано (Сервер обновил сундук или продал его).');
      } else {
        console.log('[Bot] Ошибка копания:', err.message);
      }
    }
  }
}
