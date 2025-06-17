const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');

const TOKEN = '7909919464:AAEhoJUdqgVrog1OrGmI4S9YYanuDvRz0VA';
const bot = new TelegramBot(TOKEN, { polling: true });

const userSessions = new Map();

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    userSessions.set(chatId, {});
    bot.sendMessage(chatId, 'Bienvenido. Por favor, ingresa tu número de usuario:');
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const session = userSessions.get(chatId) || {};

    // Evitar procesar el /start dos veces
    if (text === '/start') return;

    // Paso 1: Ingresar número de usuario
    if (!session.userNumber) {
        session.userNumber = text;
        userSessions.set(chatId, session);

        try {
            const response = await fetch(`https://metabet-backend-450162411664.us-central1.run.app/api/v1/get-client-data/${text}`, {
                "headers": {
                    "auth": "RgIRSnarffsoECCyiZso",
                    "content-type": "application/json",
                    "sec-ch-ua": "\"Google Chrome\";v=\"137\", \"Chromium\";v=\"137\", \"Not/A)Brand\";v=\"24\"",
                    "sec-ch-ua-mobile": "?0",
                    "sec-ch-ua-platform": "\"Windows\"",
                    "Referer": "https://agente-betgpt.web.app/",
                    "Referrer-Policy": "strict-origin-when-cross-origin"
                },
                "body": null,
                "method": "GET"
            });
            const clientData = await response.json();
            console.log(clientData);
            session.clientData = clientData;
            userSessions.set(chatId, session);

            bot.sendMessage(chatId, `Usuario encontrado. Tu saldo es: ${clientData.Balance}. Ingresa el monto de la recarga:`);
        } catch (error) {
            console.error(error);
            bot.sendMessage(chatId, 'Hubo un error al obtener los datos del usuario. Inténtalo de nuevo.');
        }
        return;
    }

    // Paso 2: Ingresar monto
    if (!session.amount) {
        const amount = parseFloat(text);
        if (isNaN(amount) || amount <= 0) {
            bot.sendMessage(chatId, 'Por favor ingresa un monto válido.');
            return;
        }

        session.amount = amount;
        userSessions.set(chatId, session);

        // Enviar recarga
        try {
            const body = {
                digitainClientId: session.clientData.digitainClientId,
                agentId: 'RgIRSnarffsoECCyiZso',
                amount: session.amount,
                token: '03AFcWeA7SlY1P1vNlTTWnd2qtQp9Hot2SCWNmJlZxL28CDHvYVtLWRgTkR90ou5dF4jca07meppK_tLBlu3FLwBncjznHogXrmyPnwMyj709ZnwDJR0RbaYIWLUQ9wmu7WvrteXH3EMEJfm0iAHQNspa7Sl1Bkuf2gXQkj22FIjxSDmkupIg4SpzlHs_RCN-1ZkUj9CXG2pfRtMh2Im5tBxBpeX4rsckJMtYaYrB1qplWnXj-EaAoW-G_vve0ay8yPlaB2cSExgEf-OQajcvuJTCve2SnQCwjLIf7EqLy9XdQLWIyRXA42nsanEmLk_d23MhLbK2jWnKA8e8K8u4ucvlinS29pm4bcvfMs0QrSPVmLriDKMPwuijHwwNbpEbGW8ueHXju17jeQFhJ0mckTrlG3L9bqMymovLygXcG9OOPHlVT8kcduWJOTXYSxC8m60g4P2e2fNH6pg_6Acx5cEHxosCwhMK-jC5xTL2EitNIQS5GikALUJnrpVetMPw0DjZ_HfPbC8UFEUm27L3pk2hdhiPhffWUIfoe7edhG8gWPTwF_RAW95d-KE4r6Kw_5fvpxBlkXBhljyMSYNfZLD4ONCQwdbSVJh8QbZ6Kb8Ep7JZr0yvkssI0jLMRpaqGqxvqSMQi-rFrIqRXumDx7B1jN1Z8PNmZlRBrD67L6I8cciN4fzhBV6YGqciAdyRxbof00L8hLNeLeyqJ820ohw9MY2HzChoj4KQUIKWrDNgg4XszfT3RBE8N9D_uT92IiKCDjgqFgmLWIfz2TiUnFtKGVzaMrQ-oq1gj7g461Qv1qkxiaDm52AT9QX32iK3GKRkMlQv6DUrgJ1WnCAHpVK7IsrhFYVJoHzaA5bZFHSvum-9Uw_1ytr3bbt7KaOMu3uLExoH2Ior1DOTzuB0C7RkARBcKat69FA0aXlcTlIq06Pco-Qb5heIIlCaKcB5I3Tmok0CE1WI3j4U33gWLHbwUljn_o4V3RkR4ZTyO6_w1bx7xGhdT0guayyQ-WqRSXcioQ5DLNVewDykmtRvO2eOaOM6mOqvORTfFKHnoYb2BQAu12r5hFzVogsHo2cux45ff8zBtUmzBat4vCsJCoiLnaXDfURSM8FCUPSeCkJ23px7KFVpRRpdPoy6QZsQB11dsqDYfbNvUrsXfPO9geonf2ICNuOHVrn323qvd2l1DjMviFT01Ro-vyMHGd_ahyCrXGFEVR3ni8iAg6SXqFmU9uhbJeqi5yXZRCpBimlOhKxfv3AxUitiJi_GLKoknK0XFEdGLHhZZab7umTxUQaY-xjmPq8pKCatHgSjo8Hgs3cqGTr63HjGj6BrAgH26C5-IE9673mXa_aCrOBmlF7YQ8v5XjMfj-cvIZ1FNbijzeD6L8PHWW-ZPPqxChlcX8zPh7h_7Rxi6b3WvV1yEIHoo_lqfwzs512Z6aZ_AB4HyIp6WqTz2VNW9SOaGpUa8sVpj5pvFp0YKqmYOwnqI_AyAieXPN5iLM1dl0ddigY5DgkgtZW8yaF-1aEjGw1YUkB0se7JEdv3TwPIiRA8ag-0V5bq5EOXND0uykHHwQu2vpp1wTJelet8LQY83lBNYdTfb7J_V7zcuqqvI1gqIt6Kt9Z8kfEvns4OJ1iHBMCVKegYIHuGfE1p5V_ytLQi9L3QiypfumMTxYg8sRTS9i7_9vPM0ZTWlcJ2ZAG2iMBTYpJzlifQYdajKpiD7D67lh7XRFlA9LnG5hNgYRtIx3fQlFzp5M5uXySCwpbLcdZ3PaHQwjDLFFw-1131_O833iL4JBrrSLMVQyHJhK-WpjTd36xi0zRGpByZqu-imHyQ9-5baGNj3JvUeGqLelY-uYqZb0MOu-O63GhrAzjC6-bAefxWwgeSt--0cSGHQqgIdjnHCth_wc4GeQm0a-w9NDYrurdAQ3SLN0pbhQ4R2zGM60BwhyrR2aZSkwBuyc395I82t8Aj13K4fDlT-5m6b31SHHaQ9WBoCE73-pVxMDToM88B1PiNhae4XQoYz8KoCLdSAxlSCF92YgMbIihZzJnDBKm-xFvXXUTq0iORWVvJ6yRWJpqieIg',
                token2: null
            };

            const res = await fetch('https://metabet-backend-450162411664.us-central1.run.app/api/v1/refill-client', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'Referer': 'https://agente-betgpt.web.app/',
                    'Referrer-Policy': 'strict-origin-when-cross-origin'
                },
                body: JSON.stringify(body)
            });

            const result = await res.json();
            bot.sendMessage(chatId, `✅ Recarga realizada con éxito. Respuesta: ${JSON.stringify(result)}`);
            userSessions.delete(chatId); // Limpiar sesión
        } catch (error) {
            console.error(error);
            bot.sendMessage(chatId, '❌ Error al realizar la recarga.');
        }
    }
});
