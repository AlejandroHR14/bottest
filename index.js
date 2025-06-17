const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { createWorker } = require('tesseract.js');

// CONFIGURAR ZONA HORARIA DE LA PAZ, BOLIVIA
process.env.TZ = 'America/La_Paz';

const TOKEN = '7909919464:AAEhoJUdqgVrog1OrGmI4S9YYanuDvRz0VA';
const bot = new TelegramBot(TOKEN, { polling: true });

const userSessions = new Map();
let browser = null;

// CONFIGURACIÓN PARA 75-100 USUARIOS SIMULTÁNEOS
const MAX_CONCURRENT_REQUESTS = 50;
const MAX_PAGES_POOL = 20;
const REQUEST_TIMEOUT = 20000;

// Control de concurrencia
let activeRequests = 0;
const requestQueue = [];
const pagePool = [];
let activePagesCount = 0;

// Métricas extendidas con tracking de montos por día
const metrics = {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    queueLength: 0,
    dailyRecharges: new Map(), // Map para almacenar recargas por día
    totalRechargedToday: 0,
    totalRechargedAllTime: 0
};

// Asegurarse de que el directorio de comprobantes exista
const receiptsDir = path.join(__dirname, 'receipts');
if (!fs.existsSync(receiptsDir)) {
    fs.mkdirSync(receiptsDir, { recursive: true });
}

// Función helper para obtener hora de Bolivia
function getBoliviaTime(date = new Date()) {
    // Bolivia está en UTC-4
    return new Date(date.toLocaleString("en-US", {timeZone: "America/La_Paz"}));
}

// Función para obtener la fecha actual en formato YYYY-MM-DD (Bolivia)
function getTodayDate() {
    const today = new Date();
    // Asegurar zona horaria de Bolivia
    const boliviaTime = getBoliviaTime(today);
    return boliviaTime.toISOString().split('T')[0];
}

// Función para obtener la fecha de hoy en formato DD/MM/YYYY (para validación de comprobantes - Bolivia)
function getTodayDateFormatted() {
    const today = new Date();
    // Asegurar zona horaria de Bolivia
    const boliviaTime = getBoliviaTime(today);
    const dd = String(boliviaTime.getDate()).padStart(2, '0');
    const mm = String(boliviaTime.getMonth() + 1).padStart(2, '0');
    const yyyy = boliviaTime.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
}

// Función para obtener la fecha de ayer en formato YYYY-MM-DD (Bolivia)
function getYesterdayDate() {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    // Asegurar zona horaria de Bolivia
    const boliviaTime = getBoliviaTime(yesterday);
    return boliviaTime.toISOString().split('T')[0];
}

// Función para registrar una recarga
function recordRecharge(amount) {
    const today = getTodayDate();

    // Actualizar métricas diarias
    if (!metrics.dailyRecharges.has(today)) {
        metrics.dailyRecharges.set(today, {
            amount: 0,
            count: 0
        });
    }

    const dailyData = metrics.dailyRecharges.get(today);
    dailyData.amount += amount;
    dailyData.count += 1;

    // Actualizar totales
    metrics.totalRechargedToday = dailyData.amount;
    metrics.totalRechargedAllTime += amount;
}

// Función para obtener estadísticas de solo hoy y ayer
function getDailyStats() {
    const stats = [];
    const today = getTodayDate();
    const yesterday = getYesterdayDate();

    // Agregar datos de hoy
    const todayData = metrics.dailyRecharges.get(today) || { amount: 0, count: 0 };
    stats.push({
        date: today,
        amount: todayData.amount,
        count: todayData.count
    });

    // Agregar datos de ayer
    const yesterdayData = metrics.dailyRecharges.get(yesterday) || { amount: 0, count: 0 };
    stats.push({
        date: yesterday,
        amount: yesterdayData.amount,
        count: yesterdayData.count
    });

    return stats;
}

// Limpiar datos antiguos (mantener solo hoy y ayer)
function cleanOldData() {
    const today = getTodayDate();
    const yesterday = getYesterdayDate();

    // Eliminar cualquier día que no sea hoy o ayer
    for (const [date] of metrics.dailyRecharges) {
        if (date !== today && date !== yesterday) {
            metrics.dailyRecharges.delete(date);
        }
    }

    // Limpiar receipts antiguos (más de 2 días)
    try {
        const files = fs.readdirSync(receiptsDir);
        const twoDaysAgo = new Date();
        twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

        files.forEach(file => {
            const filePath = path.join(receiptsDir, file);
            const stats = fs.statSync(filePath);
            if (stats.mtime < twoDaysAgo) {
                fs.unlinkSync(filePath);
            }
        });
    } catch (error) {
        console.error('Error limpiando receipts antiguos:', error);
    }
}

// Función para descargar imagen de Telegram
function downloadImage(url, filePath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(filePath);
        https.get(url, (response) => {
            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
            file.on('error', (err) => {
                fs.unlink(filePath, () => { });
                reject(err);
            });
        }).on('error', (err) => {
            fs.unlink(filePath, () => { });
            reject(err);
        });
    });
}

// Inicializar navegador optimizado para alta concurrencia
async function initBrowser() {
    if (!browser) {
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', // Reduce uso de memoria
                '--disable-gpu',
                '--memory-pressure-off',
                '--max_old_space_size=8192' // 8GB para Node.js
            ]
        });

        // Manejar cierre inesperado del navegador
        browser.on('disconnected', async () => {
            console.log('Browser disconnected, reinitializing...');
            browser = null;
            pagePool.length = 0;
            activePagesCount = 0;
        });
    }
    return browser;
}

// Obtener página optimizada del pool
async function getPage() {
    if (pagePool.length > 0) {
        return pagePool.pop();
    }

    if (activePagesCount >= MAX_PAGES_POOL) {
        // Esperar a que se libere una página
        await new Promise(resolve => setTimeout(resolve, 100));
        return getPage();
    }

    const browser = await initBrowser();
    activePagesCount++;

    const page = await browser.newPage();

    // Solo optimizaciones básicas
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const resourceType = req.resourceType();
        if (['stylesheet', 'image', 'font', 'media'].includes(resourceType)) {
            req.abort();
        } else {
            req.continue();
        }
    });

    return page;
}

// Devolver página al pool o cerrarla (simplificado)
async function releasePage(page) {
    try {
        // Limpiar página básico
        await page.evaluate(() => {
            localStorage.clear();
            sessionStorage.clear();
        });

        if (pagePool.length < MAX_PAGES_POOL / 2) {
            pagePool.push(page);
        } else {
            await page.close();
            activePagesCount--;
        }
    } catch (error) {
        try {
            await page.close();
        } catch (e) { }
        activePagesCount--;
        console.error('Error releasing page:', error.message);
    }
}

// Sistema de cola avanzado
async function processQueue() {
    while (requestQueue.length > 0 && activeRequests < MAX_CONCURRENT_REQUESTS) {
        const { resolve, reject, task } = requestQueue.shift();
        activeRequests++;
        metrics.totalRequests++;

        // Procesar de forma asíncrona
        (async () => {
            try {
                const result = await Promise.race([
                    task(),
                    new Promise((_, timeoutReject) =>
                        setTimeout(() => timeoutReject(new Error('Request timeout')), REQUEST_TIMEOUT)
                    )
                ]);
                metrics.successfulRequests++;
                resolve(result);
            } catch (error) {
                metrics.failedRequests++;
                reject(error);
            } finally {
                activeRequests--;
                metrics.queueLength = requestQueue.length;
                // Procesar siguiente inmediatamente
                setImmediate(processQueue);
            }
        })();
    }
}

// Wrapper para cola con prioridad
function queueRequest(task, priority = 0) {
    return new Promise((resolve, reject) => {
        const request = { resolve, reject, task, priority };

        // Insertar según prioridad
        if (priority > 0) {
            requestQueue.unshift(request);
        } else {
            requestQueue.push(request);
        }

        metrics.queueLength = requestQueue.length;
        processQueue();
    });
}

// Función makeApiRequest simplificada
async function makeApiRequest(endpoint, method = 'GET', body = null, userNumber = null) {
    return queueRequest(async () => {
        const page = await getPage();
        try {
            // Navegar al sitio web primero para establecer el contexto
            await page.goto('https://agente-betgpt.web.app/', { waitUntil: 'networkidle2' });

            // Determinar URL
            const url = userNumber ?
                `https://metabet-backend-450162411664.us-central1.run.app/api/v1/get-client-data/${userNumber}` :
                endpoint;

            // Hacer la petición desde el contexto del sitio web
            const result = await page.evaluate(async (url, method, body) => {
                const options = {
                    method: method,
                    headers: {
                        "auth": "RgIRSnarffsoECCyiZso",
                        "content-type": "application/json"
                    }
                };

                if (body) {
                    options.body = JSON.stringify(body);
                }

                const response = await fetch(url, options);
                return await response.json();
            }, url, method, body);

            return result;
        } finally {
            await releasePage(page);
        }
    });
}

// Función para validar comprobante con OCR - CON ZONA HORARIA BOLIVIA
async function validateReceipt(filePath, expectedAmount, paymentRequestTime) {
    console.log(`Validando comprobante: ${filePath}, monto esperado: ${expectedAmount}`);

    try {
        // Iniciar worker de Tesseract para español
        const worker = await createWorker('spa');

        // Reconocer texto en la imagen
        const { data: { text } } = await worker.recognize(filePath);
        console.log('Texto extraído del comprobante:', text);

        // Liberar recursos
        await worker.terminate();

        // Validaciones
        const validations = {
            correctAccount: false,
            correctAmount: false,
            correctDate: false,
            correctTime: false
        };

        // 1. Validar cuenta destino: 1001382536
        validations.correctAccount = text.includes('1001382536');

        // 2. Validar monto
        // Buscar diferentes formatos del monto: 200.00, Bs200.00, Bs 200.00, etc.
        const amountStr = expectedAmount.toFixed(2);
        validations.correctAmount =
            text.includes(`${amountStr}`) ||
            text.includes(`Bs${amountStr}`) ||
            text.includes(`Bs ${amountStr}`) ||
            text.includes(`${expectedAmount}`); // También sin decimales

        // 3. Validar fecha (debe ser de hoy) - Formatos múltiples CON ZONA HORARIA BOLIVIA
        const today = new Date();
        // Convertir a hora de Bolivia
        const boliviaToday = getBoliviaTime(today);

        const dd = String(boliviaToday.getDate()).padStart(2, '0');
        const mm = String(boliviaToday.getMonth() + 1).padStart(2, '0');
        const yyyy = boliviaToday.getFullYear();

        // Formatos numéricos
        const todayFormatted = `${dd}/${mm}/${yyyy}`; // DD/MM/YYYY
        const todayFormatted2 = `${dd}-${mm}-${yyyy}`; // DD-MM-YYYY
        const todayFormatted3 = `${dd}.${mm}.${yyyy}`; // DD.MM.YYYY

        // Formatos en español (minúsculas y mayúsculas)
        const meses = [
            'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
            'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
        ];
        const mesesMayus = [
            'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
            'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
        ];

        const mesActual = meses[boliviaToday.getMonth()];
        const mesActualMayus = mesesMayus[boliviaToday.getMonth()];
        const diaNumero = boliviaToday.getDate(); // Sin ceros a la izquierda

        // Formatos en español con diferentes variaciones
        const todaySpanish1 = `${diaNumero} de ${mesActual}, ${yyyy}`;
        const todaySpanish2 = `${diaNumero} de ${mesActual} ${yyyy}`;
        const todaySpanish3 = `${mesActual} ${diaNumero}, ${yyyy}`;
        const todaySpanish4 = `${diaNumero} ${mesActual} ${yyyy}`;

        // Formatos con mayúsculas
        const todaySpanish5 = `${diaNumero} de ${mesActualMayus}, ${yyyy}`;
        const todaySpanish6 = `${diaNumero} de ${mesActualMayus} ${yyyy}`;
        const todaySpanish7 = `${mesActualMayus} ${diaNumero}, ${yyyy}`;
        const todaySpanish8 = `${diaNumero} ${mesActualMayus} ${yyyy}`;

        // Formatos con "a las"
        const todaySpanish9 = `${diaNumero} de ${mesActual}, ${yyyy} a las`;
        const todaySpanish10 = `${diaNumero} de ${mesActualMayus}, ${yyyy} a las`;

        validations.correctDate =
            text.includes(todayFormatted) ||
            text.includes(todayFormatted2) ||
            text.includes(todayFormatted3) ||
            text.includes(todaySpanish1) ||
            text.includes(todaySpanish2) ||
            text.includes(todaySpanish3) ||
            text.includes(todaySpanish4) ||
            text.includes(todaySpanish5) ||
            text.includes(todaySpanish6) ||
            text.includes(todaySpanish7) ||
            text.includes(todaySpanish8) ||
            text.includes(todaySpanish9) ||
            text.includes(todaySpanish10);

        console.log(`Buscando fechas Bolivia: ${todayFormatted}, ${todaySpanish1}, ${todaySpanish5}, ${todaySpanish10}`);

        // 4. Validar tiempo CON ZONA HORARIA BOLIVIA
        // Extraer la hora del texto (formato común: HH:MM:SS, HH:MM, formato 12h con AM/PM)
        const timeRegex12h = /(\d{1,2}):(\d{2}):?(\d{2})?\s*(AM|PM)/gi;
        const timeRegex24h = /(\d{1,2}):(\d{2}):?(\d{2})?/g;

        // Primero buscar formato 12 horas (AM/PM)
        let timeMatches = [...text.matchAll(timeRegex12h)];
        let is12HourFormat = timeMatches.length > 0;

        // Si no encuentra formato 12h, buscar formato 24h
        if (!is12HourFormat) {
            timeMatches = [...text.matchAll(timeRegex24h)];
        }

        if (timeMatches.length > 0) {
            // Obtener el último tiempo encontrado en el texto (probablemente el momento del pago)
            const lastTime = timeMatches[timeMatches.length - 1];
            let hours = parseInt(lastTime[1]);
            const minutes = parseInt(lastTime[2]);
            const seconds = lastTime[3] ? parseInt(lastTime[3]) : 0;

            // Convertir de 12h a 24h si es necesario
            if (is12HourFormat) {
                const ampm = lastTime[4].toUpperCase();
                if (ampm === 'PM' && hours !== 12) {
                    hours += 12;
                } else if (ampm === 'AM' && hours === 12) {
                    hours = 0;
                }
            }

            // Obtener la fecha/hora de cuando se solicitó el QR EN HORA DE BOLIVIA
            const paymentDate = typeof paymentRequestTime === 'number'
                ? new Date(paymentRequestTime)
                : paymentRequestTime;

            // Convertir paymentDate a hora de Bolivia para comparación correcta
            const paymentDateBolivia = getBoliviaTime(paymentDate);

            // Crear la fecha/hora del comprobante usando la fecha actual de Bolivia
            const receiptTime = new Date();
            const boliviaTime = getBoliviaTime(receiptTime);
            boliviaTime.setHours(hours, minutes, seconds, 0);

            // Calcular diferencia en milisegundos
            let timeDifference = boliviaTime.getTime() - paymentDateBolivia.getTime();

            // Si la diferencia es muy grande (más de 12 horas), probablemente sea de otro día
            if (timeDifference < -12 * 60 * 60 * 1000) {
                boliviaTime.setDate(boliviaTime.getDate() + 1);
                timeDifference = boliviaTime.getTime() - paymentDateBolivia.getTime();
            } else if (timeDifference > 12 * 60 * 60 * 1000) {
                boliviaTime.setDate(boliviaTime.getDate() - 1);
                timeDifference = boliviaTime.getTime() - paymentDateBolivia.getTime();
            }

            const differenceMinutes = Math.abs(timeDifference) / (1000 * 60);

            // CORRECCIÓN: Permitir comprobantes que sean hasta 2 minutos ANTES o hasta 5 minutos DESPUÉS
            // Esto cubre casos donde el usuario tomó captura justo antes de que llegue la notificación
            validations.correctTime = (timeDifference >= -120000 && differenceMinutes <= 5); // -120000ms = -2 minutos

            console.log(`Formato detectado: ${is12HourFormat ? '12h (AM/PM)' : '24h'}`);
            console.log(`Hora QR solicitado (Bolivia): ${paymentDateBolivia.toLocaleTimeString()}`);
            console.log(`Hora del comprobante (Bolivia): ${boliviaTime.toLocaleTimeString()}`);
            console.log(`Diferencia: ${(timeDifference / (1000 * 60)).toFixed(2)} minutos`);
            console.log(`Diferencia absoluta: ${differenceMinutes.toFixed(2)} minutos`);
            console.log(`Comprobante válido por tiempo: ${validations.correctTime}`);
        } else {
            // Si no se encuentra tiempo, asumir válido por seguridad
            validations.correctTime = true;
            console.log('No se encontró hora en el comprobante, asumiendo válido');
        }

        // Resultado final
        const isValid = Object.values(validations).every(v => v);

        return {
            isValid,
            validations,
            text
        };
    } catch (error) {
        console.error('Error en OCR:', error);
        return {
            isValid: false,
            validations: {
                correctAccount: false,
                correctAmount: false,
                correctDate: false,
                correctTime: false
            },
            error: error.message
        };
    }
}

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    userSessions.set(chatId, {});
    bot.sendMessage(chatId, 'Bienvenido al bot para Recargas. \nPor favor, ingresa tu número de usuario:');
});

// Comando para cancelar proceso
bot.onText(/\/cancel/, (msg) => {
    const chatId = msg.chat.id;
    userSessions.delete(chatId);
    bot.sendMessage(chatId, '❌ Proceso cancelado. Escribe /start para comenzar de nuevo.');
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const session = userSessions.get(chatId) || {};

    // Evitar procesar comandos como números de usuario
    if (text === '/start' || text === '/stats' || text === '/report' || text === '/cancel') return;

    // Actualizar última actividad
    session.lastActivity = Date.now();
    userSessions.set(chatId, session);

    // Mostrar estado de cola si está muy llena
    if (requestQueue.length > 20) {
        bot.sendMessage(chatId, `⏳ Servidor ocupado (${requestQueue.length} en cola). Procesando tu solicitud...`);
    }

    // Paso 1: Ingresar número de usuario
    if (!session.userNumber) {
        // Validar que sea texto y no una imagen u otro archivo
        if (!text || msg.photo || msg.document || msg.video || msg.audio || msg.voice || msg.sticker) {
            bot.sendMessage(chatId, '❌ Por favor ingresa solo tu número de usuario (texto), no imágenes ni archivos.');
            return;
        }

        session.userNumber = text.trim();
        userSessions.set(chatId, session);

        try {
            const clientData = await makeApiRequest(null, 'GET', null, text.trim());

            console.log('Consulta usuario:', text);

            session.clientData = clientData;
            userSessions.set(chatId, session);

            if (clientData.ok === false || clientData.error) {
                bot.sendMessage(chatId, `Error al encontrar el usuario. \nEscribe /start para comenzar de nuevo.\nSi el problema persiste, contacta al cajero para recarga manual.`);
                // Limpiar la sesión si hay error
                userSessions.delete(chatId);
            } else {
                bot.sendMessage(chatId, `Usuario encontrado. Tu saldo es: ${clientData.msg.Balance}. Ingresa el monto de la recarga:`);
            }
        } catch (error) {
            console.error('Error en consulta usuario:', error.message);
            if (error.message.includes('timeout')) {
                bot.sendMessage(chatId, '⏰ Timeout. El servidor está muy ocupado, intenta en unos minutos.');
            } else {
                bot.sendMessage(chatId, 'Hubo un error al obtener los datos del usuario. Inténtalo de nuevo.');
            }
            // Limpiar la sesión si hay error
            userSessions.delete(chatId);
        }
        return;
    }

    // Paso 2: Ingresar monto
    if (!session.amount) {
        // Validar que sea texto y no una imagen u otro archivo
        if (!text || msg.photo || msg.document || msg.video || msg.audio || msg.voice || msg.sticker) {
            bot.sendMessage(chatId, '❌ Por favor ingresa solo el monto de recarga (número), no imágenes ni archivos.');
            return;
        }

        const amount = parseFloat(text.trim());
        if (isNaN(amount) || amount <= 0) {
            bot.sendMessage(chatId, 'Por favor ingresa un monto válido.');
            return;
        }

        session.amount = amount;
        session.paymentRequestTime = Date.now(); // Registrar tiempo de solicitud
        session.waitingForReceipt = true;
        userSessions.set(chatId, session);

        // Enviar mensaje con QR y instrucciones
        const qrMessage = `📲 *Realiza el pago de Bs ${amount.toFixed(2)}*

1️⃣ Escanea el QR adjunto
2️⃣ Envía una captura del comprobante

⏳ Tienes 5 minutos para completar el pago

Si no envías el comprobante en ese tiempo, la solicitud se cancelará automáticamente

SOLO MANDAR EN FORMATO DE IMAGEN, NO SE ADMITEN PDF`;

        try {
            // Verificar que el archivo QR existe
            const qrPath = path.join(__dirname, 'COBRO-QR.jpeg');
            if (fs.existsSync(qrPath)) {
                // Enviar QR
                await bot.sendPhoto(chatId, qrPath, {
                    caption: qrMessage,
                    parse_mode: 'Markdown'
                });

                console.log(`QR enviado a ${chatId} para monto Bs ${amount}`);

                // Establecer temporizador para cancelar si no hay respuesta
                setTimeout(() => {
                    // Verificar si todavía está esperando el comprobante
                    const currentSession = userSessions.get(chatId);
                    if (currentSession && currentSession.waitingForReceipt) {
                        bot.sendMessage(chatId, '⏰ Tiempo de espera agotado. La solicitud ha sido cancelada. Escribe /start para comenzar de nuevo.');
                        userSessions.delete(chatId);
                    }
                }, 5 * 60 * 1000); // 5 minutos
            } else {
                throw new Error('QR file not found');
            }
        } catch (error) {
            console.error('Error enviando QR:', error);
            bot.sendMessage(chatId, '❌ Error al generar el código QR. Por favor, intenta de nuevo.');
            userSessions.delete(chatId);
        }

        return;
    }

    // Paso 3: Recibir y procesar comprobante de pago
    if (session.waitingForReceipt) {
        // Verificar si es una imagen
        if (!msg.photo) {
            bot.sendMessage(chatId, '❌ Por favor envía una captura del comprobante de pago.');
            return;
        }

        bot.sendMessage(chatId, '🔍 Verificando el comprobante...');

        // Obtener la foto con mejor resolución
        const photo = msg.photo[msg.photo.length - 1];

        try {
            // Descargar la imagen para procesar
            const fileInfo = await bot.getFile(photo.file_id);
            const photoUrl = `https://api.telegram.org/file/bot${TOKEN}/${fileInfo.file_path}`;

            // Crear nombre único para el archivo
            const fileName = `receipt_${chatId}_${Date.now()}.jpg`;
            const filePath = path.join(receiptsDir, fileName);

            // Descargar la imagen usando https nativo
            await downloadImage(photoUrl, filePath);

            // Verificar tiempo desde solicitud
            const currentTime = Date.now();
            const timeElapsedMinutes = (currentTime - session.paymentRequestTime) / (1000 * 60);

            if (timeElapsedMinutes > 5) {
                bot.sendMessage(chatId, '❌ El comprobante fue enviado después del tiempo límite (5 minutos). La operación ha sido cancelada.');
                userSessions.delete(chatId);
                return;
            }

            // Validar el comprobante con OCR
            const validationResult = await validateReceipt(
                filePath,
                session.amount,
                new Date(session.paymentRequestTime)
            );

            if (!validationResult.isValid) {
                // Mostrar errores específicos en la validación
                let errorMessage = '❌ El comprobante no es válido:';
                const v = validationResult.validations;

                if (!v.correctAccount) errorMessage += '\n- La cuenta destino no es 1001382536';
                if (!v.correctAmount) errorMessage += `\n- El monto no coincide con Bs ${session.amount.toFixed(2)}`;
                if (!v.correctDate) errorMessage += '\n- La fecha del comprobante no es de hoy';
                if (!v.correctTime) errorMessage += '\n- El tiempo del comprobante excede los 5 minutos permitidos o es anterior a la solicitud del QR';

                errorMessage += '\n\n🔄 Escribe /start para comenzar de nuevo';
                errorMessage += '\n📞 O contacta con el número del cajero para recarga manual';

                bot.sendMessage(chatId, errorMessage);
                userSessions.delete(chatId); // Eliminar la sesión
                return;
            }

            // Comprobante válido, continuar con la recarga
            bot.sendMessage(chatId, '✅ Comprobante validado correctamente. Procesando recarga...');

            // Eliminar flag de espera
            session.waitingForReceipt = false;
            userSessions.set(chatId, session);

            // Continuar con el proceso de recarga
            try {
                const body = {
                    digitainClientId: session.clientData.msg.digitainClientId,
                    agentId: 'RgIRSnarffsoECCyiZso',
                    amount: session.amount,
                    token: '03AFcWeA7SlY1P1vNlTTWnd2qtQp9Hot2SCWNmJlZxL28CDHvYVtLWRgTkR90ou5dF4jca07meppK_tLBlu3FLwBncjznHogXrmyPnwMyj709ZnwDJR0RbaYIWLUQ9wmu7WvrteXH3EMEJfm0iAHQNspa7Sl1Bkuf2gXQkj22FIjxSDmkupIg4SpzlHs_RCN-1ZkUj9CXG2pfRtMh2Im5tBxBpeX4rsckJMtYaYrB1qplWnXj-EaAoW-G_vve0ay8yPlaB2cSExgEf-OQajcvuJTCve2SnQCwjLIf7EqLy9XdQLWIyRXA42nsanEmLk_d23MhLbK2jWnKA8e8K8u4ucvlinS29pm4bcvfMs0QrSPVmLriDKMPwuijHwwNbpEbGW8ueHXju17jeQFhJ0mckTrlG3L9bqMymovLygXcG9OOPHlVT8kcduWJOTXYSxC8m60g4P2e2fNH6pg_6Acx5cEHxosCwhMK-jC5xTL2EitNIQS5GikALUJnrpVetMPw0DjZ_HfPbC8UFEUm27L3pk2hdhiPhffWUIfoe7edhG8gWPTwF_RAW95d-KE4r6Kw_5fvpxBlkXBhljyMSYNfZLD4ONCQwdbSVJh8QbZ6Kb8Ep7JZr0yvkssI0jLMRpaqGqxvqSMQi-rFrIqRXumDx7B1jN1Z8PNmZlRBrD67L6I8cciN4fzhBV6YGqciAdyRxbof00L8hLNeLeyqJ820ohw9MY2HzChoj4KQUIKWrDNgg4XszfT3RBE8N9D_uT92IiKCDjgqFgmLWIfz2TiUnFtKGVzaMrQ-oq1gj7g461Qv1qkxiaDm52AT9QX32iK3GKRkMlQv6DUrgJ1WnCAHpVK7IsrhFYVJoHzaA5bZFHSvum-9Uw_1ytr3bbt7KaOMu3uLExoH2Ior1DOTzuB0C7RkARBcKat69FA0aXlcTlIq06Pco-Qb5heIIlCaKcB5I3Tmok0CE1WI3j4U33gWLHbwUljn_o4V3RkR4ZTyO6_w1bx7xGhdT0guayyQ-WqRSXcioQ5DLNVewDykmtRvO2eOaOM6mOqvORTfFKHnoYb2BQAu12r5hFzVogsHo2cux45ff8zBtUmzBat4vCsJCoiLnaXDfURSM8FCUPSeCkJ23px7KFVpRRpdPoy6QZsQB11dsqDYfbNvUrsXfPO9geonf2ICNuOHVrn323qvd2l1DjMviFT01Ro-vyMHGd_ahyCrXGFEVR3ni8iAg6SXqFmU9uhbJeqi5yXZRCpBimlOhKxfv3AxUitiJi_GLKoknK0XFEdGLHhZZab7umTxUQaY-xjmPq8pKCatHgSjo8Hgs3cqGTr63HjGj6BrAgH26C5-IE9673mXa_aCrOBmlF7YQ8v5XjMfj-cvIZ1FNbijzeD6L8PHWW-ZPPqxChlcX8zPh7h_7Rxi6b3WvV1yEIHoo_lqfwzs512Z6aZ_AB4HyIp6WqTz2VNW9SOaGpUa8sVpj5pvFp0YKqmYOwnqI_AyAieXPN5iLM1dl0ddigY5DgkgtZW8yaF-1aEjGw1YUkB0se7JEdv3TwPIiRA8ag-0V5bq5EOXND0uykHHwQu2vpp1wTJelet8LQY83lBNYdTfb7J_V7zcuqqvI1gqIt6Kt9Z8kfEvns4OJ1iHBMCVKegYIHuGfE1p5V_ytLQi9L3QiypfumMTxYg8sRTS9i7_9vPM0ZTWlcJ2ZAG2iMBTYpJzlifQYdajKpiD7D67lh7XRFlA9LnG5hNgYRtIx3fQlFzp5M5uXySCwpbLcdZ3PaHQwjDLFFw-1131_O833iL4JBrrSLMVQyHJhK-WpjTd36xi0zRGpByZqu-imHyQ9-5baGNj3JvUeGqLelY-uYqZb0MOu-O63GhrAzjC6-bAefxWwgeSt--0cSGHQqgIdjnHCth_wc4GeQm0a-w9NDYrurdAQ3SLN0pbhQ4R2zGM60BwhyrR2aZSkwBuyc395I82t8Aj13K4fDlT-5m6b31SHHaQ9WBoCE73-pVxMDToM88B1PiNhae4XQoYz8KoCLdSAxlSCF92YgMbIihZzJnDBKm-xFvXXUTq0iORWVvJ6yRWJpqieIg',
                    token2: null
                };

                const result = await makeApiRequest('https://metabet-backend-450162411664.us-central1.run.app/api/v1/refill-client', 'POST', body);

                console.log('Resultado recarga:', result);

                if (result.ok === true) {
                    // Registrar la recarga exitosa
                    recordRecharge(session.amount);

                    const successMessage = `✅ Carga exitosa a ${session.userNumber}

Monto: Bs ${session.amount.toFixed(2)}
Nuevo balance: Bs ${result.msg}

Ingreso ➡️: https://metabet.tv/es/auth/agent/${session.clientData.msg.token}`;

                    bot.sendMessage(chatId, successMessage);

                    console.log(`💰 Recarga registrada: Bs ${session.amount} - Total hoy: Bs ${metrics.totalRechargedToday}`);
                } else {
                    bot.sendMessage(chatId, `❌ Error en la recarga: ${JSON.stringify(result)}`);
                }

                userSessions.delete(chatId);
            } catch (error) {
                console.error('Error en recarga:', error.message);
                bot.sendMessage(chatId, '❌ Error al realizar la recarga. Intenta nuevamente.');
                userSessions.delete(chatId);
            }

        } catch (error) {
            console.error('Error procesando comprobante:', error);
            bot.sendMessage(chatId, '❌ Error al procesar el comprobante. Por favor intenta nuevamente con /start');
            userSessions.delete(chatId);
        }

        return;
    }
});

// Comando para ver métricas simplificadas
bot.onText(/\/stats/, (msg) => {
    const chatId = msg.chat.id;
    const dailyStats = getDailyStats();

    let statsMessage = `📊 **Estadísticas del Bot**\n\n`;

    // Estadísticas del sistema
    statsMessage += `🔄 **Sistema:**\n`;
    statsMessage += `• Peticiones activas: ${activeRequests}/${MAX_CONCURRENT_REQUESTS}\n`;
    statsMessage += `• En cola: ${metrics.queueLength}\n`;
    statsMessage += `• Páginas activas: ${activePagesCount}/${MAX_PAGES_POOL}\n`;
    statsMessage += `• Sesiones activas: ${userSessions.size}\n\n`;

    // Estadísticas de recargas
    statsMessage += `💰 **Recargas:**\n`;

    // Hoy
    const today = dailyStats[0];
    statsMessage += `• Hoy: Bs ${today.amount.toFixed(2)} (${today.count} recargas)\n`;

    // Ayer
    const yesterday = dailyStats[1];
    statsMessage += `• Ayer: Bs ${yesterday.amount.toFixed(2)} (${yesterday.count} recargas)\n`;

    // Total (hoy + ayer)
    const total = today.amount + yesterday.amount;
    statsMessage += `• Total (2 días): Bs ${total.toFixed(2)}\n`;

    bot.sendMessage(chatId, statsMessage, { parse_mode: 'Markdown' });
});

// Comando para reporte diario detallado
bot.onText(/\/report/, (msg) => {
    const chatId = msg.chat.id;
    const today = getTodayDate();
    const todayData = metrics.dailyRecharges.get(today) || { amount: 0, count: 0 };

    const reportMessage = `📋 **Reporte del día ${today}**

💰 **Total recargado:** Bs ${todayData.amount.toFixed(2)}
🔢 **Número de recargas:** ${todayData.count}
📊 **Promedio por recarga:** Bs ${todayData.count > 0 ? (todayData.amount / todayData.count).toFixed(2) : '0.00'}

🔄 **Estado del sistema:**
• Peticiones activas: ${activeRequests}
• Cola de espera: ${metrics.queueLength}
• Sesiones activas: ${userSessions.size}

🕐 **Hora local Bolivia:** ${getBoliviaTime().toLocaleString('es-BO')}`;

    bot.sendMessage(chatId, reportMessage, { parse_mode: 'Markdown' });
});

// Actualizar total de hoy al iniciar cada día
setInterval(() => {
    const today = getTodayDate();
    const todayData = metrics.dailyRecharges.get(today) || { amount: 0, count: 0 };
    metrics.totalRechargedToday = todayData.amount;
}, 60000); // Cada minuto

// Limpieza automática cada 5 minutos
setInterval(async () => {
    // Limpiar páginas excesivas del pool
    while (pagePool.length > MAX_PAGES_POOL / 2) {
        const page = pagePool.pop();
        try {
            await page.close();
            activePagesCount--;
        } catch (e) { }
    }

    // Limpiar sesiones muy antiguas (más de 1 hora)
    const oneHourAgo = Date.now() - 3600000;
    for (const [chatId, session] of userSessions.entries()) {
        if (!session.lastActivity || session.lastActivity < oneHourAgo) {
            userSessions.delete(chatId);
        }
    }

    console.log(`🧹 Limpieza automática - Páginas: ${activePagesCount}, Sesiones: ${userSessions.size}`);
}, 300000);

// Limpieza automática cada hora
setInterval(async () => {
    // Limpiar datos antiguos (conservar solo hoy y ayer)
    cleanOldData();

    // Log de estado con hora de Bolivia
    const today = getTodayDate();
    const todayData = metrics.dailyRecharges.get(today) || { amount: 0, count: 0 };
    const boliviaTime = getBoliviaTime();
    console.log(`📊 Estado Bolivia (${boliviaTime.toLocaleString('es-BO')}): Hoy Bs ${todayData.amount.toFixed(2)} (${todayData.count} recargas) | Páginas: ${activePagesCount} | Sesiones: ${userSessions.size}`);
}, 3600000); // Cada hora

// Manejo de cierre graceful
process.on('SIGINT', async () => {
    console.log('🔄 Cerrando servidor...');

    // Mostrar estadísticas finales con hora de Bolivia
    const today = getTodayDate();
    const todayData = metrics.dailyRecharges.get(today) || { amount: 0, count: 0 };
    const boliviaTime = getBoliviaTime();
    console.log(`📊 Estadísticas finales del día (Bolivia ${boliviaTime.toLocaleString('es-BO')}): Bs ${todayData.amount.toFixed(2)} en ${todayData.count} recargas`);

    // Cerrar todas las páginas
    for (const page of pagePool) {
        try {
            await page.close();
        } catch (e) { }
    }

    // Cerrar navegador
    if (browser) {
        await browser.close();
    }

    console.log('✅ Servidor cerrado correctamente');
    process.exit();
});

console.log(`🚀 Bot iniciado con zona horaria Bolivia (UTC-4) - ${getBoliviaTime().toLocaleString('es-BO')}`);
console.log('⚡ Optimizado para 75-100 usuarios simultáneos con verificación de comprobantes');