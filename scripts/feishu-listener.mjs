import * as lark from '@larksuiteoapi/node-sdk';
import 'dotenv/config';

const eventDispatcher = new lark.EventDispatcher({}).register({
  'im.message.receive_v1': async (data) => {
    const msg = data.message;
    const senderId = data.sender?.sender_id?.open_id;
    const chatId = msg.chat_id;
    const msgType = msg.message_type;
    let content = '';

    try {
      const parsed = JSON.parse(msg.content);
      content = parsed.text || JSON.stringify(parsed);
    } catch {
      content = msg.content;
    }

    const line = JSON.stringify({
      ts: new Date().toISOString(),
      sender: senderId,
      chat: chatId,
      type: msgType,
      content,
    });

    console.log('[FEISHU_MSG]' + line);
  },
});

const wsClient = new lark.WSClient({
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  loggerLevel: lark.LoggerLevel.info,
});

console.log('[FEISHU] Starting WebSocket listener...');
wsClient.start({ eventDispatcher });
