const mineflayer = require('mineflayer');
const { SocksProxyAgent } = require('socks-proxy-agent');

console.log("Запуск нового минимального бота...");

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
  
  // Патч против краша Mineflayer 1.21 при копании
  const origDigTime = bot.digTime.bind(bot);
  bot.digTime = (block) => {
    try {
      return origDigTime(block);
    } catch (e) {
      return 250; 
    }
  };

  // Запускаем максимально чистый луп
  startFarmingLoop();
});

bot.on('error', (err) => console.log('[Error]', err));
bot.on('kicked', (reason) => console.log('[Kicked]', reason));

async function startFarmingLoop() {
  while (true) {
    // Пауза. Если сервер лагает, слишком частые клики античит будет "съедать" (поэтому не 100, а 400мс)
    await new Promise(r => setTimeout(r, 400));
    
    if (!bot.entity) continue;

    // Ищем сундук рядом
    const chest = bot.findBlock({
      matching: (b) => b.name.includes('chest') || b.name.includes('barrel') || b.name.includes('hopper'),
      maxDistance: 5
    });

    if (!chest) {
      console.log('[Bot] Сундуков нет. Жду...');
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }

    try {
      // Сбрасываем зависшее копание, если оно застряло с прошлого раза
      if (bot.targetDigging) {
        bot.stopDigging();
      }

      console.log(`[Bot] Начинаю бить сундук: ${chest.position.x}, ${chest.position.y}, ${chest.position.z}`);
      
      // Обязательно машем рукой для античита
      bot.swingArm('right');

      // bot.dig(блок, смотретьЛиНаБлок, типРейкаста)
      // Включаем тру-наведение: сервер должен видеть, что мы реально смотрим на сундук, когда ломаем его.
      await bot.dig(chest, true, 'raycast');
      
      console.log('[Bot] Сундук успешно сломан/продан!');

    } catch (err) {
      if (err.message === 'Digging aborted') {
        console.log('[Bot] Сервер прервал копание (Сундук продан и обновился!)');
      } else {
        console.log(`[Bot] Ошибка копания: ${err.message}`);
      }
    }
  }
}
