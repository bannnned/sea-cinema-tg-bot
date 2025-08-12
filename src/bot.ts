// cinema-bot/src/bot.ts
// MVP Telegram bot for seaside cinema booking
// Day‑1 scope: shows list, seat selection, static QR payment, admin commands, JSON persistence
// ---------------------------------------------------------------
import { Bot, InlineKeyboard, session, InputFile } from "grammy";
import type { SessionFlavor, Context } from "grammy";
import fs from "fs/promises";
import path from "path";
import { customAlphabet } from "nanoid";
import dotenv from "dotenv";
dotenv.config();

/*****************************************************************
 * Types & Helpers
 *****************************************************************/
export interface Show {
    id: number;
    dateTime: string; // ISO‑8601 or "YYYY‑MM‑DD HH:mm"
    movie: string;
}

export interface Seat {
    id: number; // unique per show (showId*100 + seatNo) — lazy rule
    seatNo: number;
    showId: number;
    status: "free" | "hold" | "paid";
    orderId?: string;
}

export interface Order {
    id: string;
    tgUser: number;
    showId: number;
    seatIds: number[];
    amount: number;
    payStatus: "pending" | "paid";
    last4?: string; // last 4 digits user sends after manual payment
    created: number; // unix ts ms
}

// Paths --------------------------------------------------------------------
const DATA_DIR = path.resolve("./data");
const SHOWS_FILE = path.join(DATA_DIR, "shows.json");
const SEATS_FILE = path.join(DATA_DIR, "seats.json");
const ORDERS_FILE = path.join(DATA_DIR, "orders.json");

async function ensureDir() {
    await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
    try {
        const txt = await fs.readFile(file, "utf8");
        return JSON.parse(txt) as T;
    } catch {
        await fs.writeFile(file, JSON.stringify(fallback, null, 2));
        return fallback;
    }
}

async function writeJson(file: string, data: any) {
    await fs.writeFile(file, JSON.stringify(data, null, 2));
}
(async () => {
    /*****************************************************************
     * Boot‑load persistent data
     *****************************************************************/
    await ensureDir();

    let shows: Show[] = await readJson<Show[]>(SHOWS_FILE, [
        { id: 1, dateTime: "2025‑08‑09 21:00", movie: "Dune: Part Two" },
        { id: 2, dateTime: "2025‑08‑10 21:00", movie: "Interstellar" },
    ]);

    let seats: Seat[] = await readJson<Seat[]>(SEATS_FILE, []);
    if (seats.length === 0) {
        const tmpl: Seat[] = [];
        for (const show of shows) {
            for (let n = 1; n <= 25; n++) {
                tmpl.push({
                    id: show.id * 100 + n,
                    seatNo: n,
                    showId: show.id,
                    status: "free",
                });
            }
        }
        seats = tmpl;
        await writeJson(SEATS_FILE, seats);
    }

    let orders: Order[] = await readJson<Order[]>(ORDERS_FILE, []);

    /*****************************************************************
     * Session (in‑memory per Telegram chat) — stores pick progress
     *****************************************************************/
    interface PickSession {
        stage: "idle" | "picking" | "await_payment";
        orderId?: string; // if already created
        showId?: number;
        seatIds?: number[];
    }

    function initialSession(): PickSession {
        return { stage: "idle" };
    }

    type MyContext = Context & SessionFlavor<PickSession>;

    /*****************************************************************
     * Bot Init
     *****************************************************************/
    const bot = new Bot<MyContext>(process.env.BOT_TOKEN!);

    bot.use(
        session<PickSession, MyContext>({ initial: initialSession })
    );

    // nanoid for Order IDs (6‑digit alnum)
    const nano = customAlphabet("123456789ABCDEFGHJKLMNPQRSTUVWXYZ", 6);

    const TICKET_PRICE = 600; // ₽
    const STATIC_QR_PNG = path.resolve("./assets/sbp_qr.png"); // Add your png under assets/

    /*****************************************************************
     * Commands
     *****************************************************************/

    bot.command("start", async (ctx) => {
        return ctx.reply(
            "Привет! Я бот кинотеатра у моря. Наберите /shows, чтобы выбрать сеанс."
        );
    });

    bot.command("shows", async (ctx) => {
        const kb = new InlineKeyboard();
        for (const show of shows) {
            kb.text(`${show.dateTime} — ${show.movie}`, `show_${show.id}`).row();
        }
        return ctx.reply("Выберите сеанс:", { reply_markup: kb });
    });

    /*****************************************************************
     * Callback handlers — choose show & seats
     *****************************************************************/

    bot.callbackQuery(/^show_(\d+)/, async (ctx) => {
        const showId = Number(ctx.match![1]);
        const show = shows.find((s) => s.id === showId);
        if (!show) return ctx.answerCallbackQuery();

        // Build seat keyboard — 5×5 grid
        const kb = new InlineKeyboard();
        const showSeats = seats.filter((s) => s.showId === showId);
        for (let row = 0; row < 5; row++) {
            for (let col = 1; col <= 5; col++) {
                const seatNo = row * 5 + col; // 1‑25
                const seat = showSeats.find((s) => s.seatNo === seatNo);
                const label = seat?.status === "free" ? `${seatNo}` : "❌";
                kb.text(label, `seat_${showId}_${seatNo}`);
            }
            kb.row();
        }
        kb.text("Готово", `done_${showId}`).row();

        ctx.session.stage = "picking";
        ctx.session.showId = showId;
        ctx.session.seatIds = [];

        const planImg = new InputFile(path.resolve("./assets/test.jpg"));

        await ctx.replyWithPhoto(planImg, {
            caption: `Схема зала для «${show.movie}», выберите места:`,
            reply_markup: kb,
        });
    });

    bot.callbackQuery(/^seat_(\d+)_(\d+)/, async (ctx) => {
        if (ctx.session.stage !== "picking") return ctx.answerCallbackQuery();
        const showId = Number(ctx.match![1]);
        const seatNo = Number(ctx.match![2]);
        const seat = seats.find((s) => s.showId === showId && s.seatNo === seatNo);
        if (!seat || seat.status !== "free") {
            return ctx.answerCallbackQuery({ text: "Увы, место уже занято" });
        }
        // toggle select
        const sel = ctx.session.seatIds ?? [];
        if (sel.includes(seat.id)) {
            ctx.session.seatIds = sel.filter((id) => id !== seat.id);
        } else {
            ctx.session.seatIds = [...sel, seat.id];
        }
        const count = ctx.session.seatIds.length;
        await ctx.answerCallbackQuery({ text: `Выбрано мест: ${count}` });
    });

    bot.callbackQuery(/^done_(\d+)/, async (ctx) => {
        if (ctx.session.stage !== "picking" || !ctx.session.seatIds?.length) {
            return ctx.answerCallbackQuery({ text: "Сначала выберите места." });
        }
        const showId = ctx.session.showId!;
        const seatIds = ctx.session.seatIds;

        // Mark seats as hold & save
        seatIds.forEach((id) => {
            const seat = seats.find((s) => s.id === id);
            if (seat) seat.status = "hold";
        });
        await writeJson(SEATS_FILE, seats);

        // Create order
        const orderId = nano();
        const amount = seatIds.length * TICKET_PRICE;
        const order: Order = {
            id: orderId,
            tgUser: ctx.from!.id,
            showId,
            seatIds,
            amount,
            payStatus: "pending",
            created: Date.now(),
        };
        orders.push(order);
        await writeJson(ORDERS_FILE, orders);

        ctx.session.stage = "await_payment";
        ctx.session.orderId = orderId;

        const kb = new InlineKeyboard().text("Я оплатил", `paid_${orderId}`);

        const qrImg = new InputFile(path.resolve("./assets/sbp_qr.png"));

        await ctx.replyWithPhoto(qrImg, {
            caption: `Заказ №${orderId}\nК оплате: ${amount} ₽\n` +
                `1️⃣ Отсканируйте QR‑код СБП и оплатите сумму.\n` +
                `2️⃣ Нажмите «Я оплатил» и укажите последние 4 цифры платежа.`,
            reply_markup: kb,
        });
        await ctx.answerCallbackQuery();
    });

    bot.callbackQuery(/^paid_(.+)/, async (ctx) => {
        const orderId = ctx.match![1];
        const order = orders.find((o) => o.id === orderId);
        if (!order) return ctx.answerCallbackQuery();
        await ctx.answerCallbackQuery();
        ctx.session.stage = "await_payment";
        await ctx.reply("Введите последние 4 цифры платежа в ответном сообщении:");
    });



    /*****************************************************************
     * Admin commands (restricted by user‑id list)
     *****************************************************************/
    const ADMINS = process.env.ADMIN_IDS?.split(",").map(Number) ?? [];
    function isAdmin(id: number) {
        return ADMINS.includes(id);
    }

    bot.command("paid", async (ctx) => {
        if (!isAdmin(ctx.from!.id) || !ctx.message) return;
        const [, orderId, last4] = ctx.message.text.split(" ");   // +деструктурируем
        const order = orders.find(o => o.id === orderId);

        if (!order) return ctx.reply("Заказ не найден");
        order.payStatus = "paid";

        if (!last4 || !/^\d{4}$/.test(last4)) {
            return ctx.reply("Нужно указать последние 4 цифры платежа.");
        }
        order.last4 = last4;
        await writeJson(ORDERS_FILE, orders);
        // mark seats paid
        order.seatIds.forEach((id) => {
            const seat = seats.find((s) => s.id === id);

            if (seat) seat.status = "paid";
        });
        await writeJson(SEATS_FILE, seats);
        ctx.reply(`Заказ ${orderId} отмечен оплаченным.`);
    });

    bot.command("free", async (ctx) => {

        if (!isAdmin(ctx.from!.id) || !ctx.message) return;
        const [orderId] = ctx.message.text.split(" ").slice(1); // заказ берется из сообщения
        console.log({ orders, orderId, msg: ctx.message })
        const orderIndex = orders.findIndex((o) => o.id === orderId);
        if (orderIndex === -1) return ctx.reply("Заказ не найден");
        const order = orders[orderIndex];
        // free seats
        order?.seatIds.forEach((id) => {
            const seat = seats.find((s) => s.id === id);
            if (seat) seat.status = "free";
        });
        orders.splice(orderIndex, 1);
        await writeJson(SEATS_FILE, seats);
        await writeJson(ORDERS_FILE, orders);
        ctx.reply(`Заказ ${orderId} отменён, места освободили.`);
    });

    // Вспомогалка: красиво показать места
    function seatsLabel(o: Order) {
        const nums = o.seatIds
            .map(id => seats.find(s => s.id === id)?.seatNo)
            .filter((n): n is number => typeof n === "number")
            .sort((a, b) => a - b);
        return nums.join(", ");
    }

    // /orders — показать незавершённые заказы кнопками
    bot.command("orders", async (ctx) => {
        if (!isAdmin(ctx.from!.id)) return;

        const pending = orders
            .filter(o => o.payStatus === "pending")
            .slice(-30)           // последние 30
            .reverse();           // свежие сверху

        if (pending.length === 0) {
            return ctx.reply("Нет незавершённых заказов.");
        }



        // Делаем несколько сообщений, если заказов много
        const chunkSize = 8;
        for (let i = 0; i < pending.length; i += chunkSize) {
            const chunk = pending.slice(i, i + chunkSize);
            const kb = new InlineKeyboard();
            for (const o of chunk) {
                const show = shows.find((s) => s.id === o.showId);
                const label = `${o.id} · ${o.amount}₽ · места: ${seatsLabel(o)}, сеанс: ${show?.movie}`;
                kb.text(`✅ ${label}`, `admin_paid:${o.id}`).row();
                kb.text(`❌ ${label}`, `admin_cancel:${o.id}`).row();
            }
            await ctx.reply("Незавершённые заказы:", { reply_markup: kb });
        }
    });

    // Кнопка «❌ Отмена»
    bot.callbackQuery(/^admin_cancel:(.+)$/, async (ctx) => {
        if (!isAdmin(ctx.from!.id)) return;
        const orderId = ctx.match![1];
        const index = orders.findIndex(o => o.id === orderId);
        if (index === -1) {
            await ctx.answerCallbackQuery({ text: "Заказ не найден", show_alert: true });
            return;
        }
        const order = orders[index];
        // освобождаем места, если не paid
        for (const sid of order?.seatIds ?? []) {
            const seat = seats.find(s => s.id === sid);
            if (seat && seat.status !== "paid") seat.status = "free";
        }
        orders.splice(index, 1);
        await Promise.all([writeJson(ORDERS_FILE, orders), writeJson(SEATS_FILE, seats)]);
        await ctx.answerCallbackQuery({ text: `Отменён ${orderId}` });
        await ctx.editMessageText(`❌ Отменён ${orderId}`);
    });

    // Кнопка «✅ Оплачен»
    bot.callbackQuery(/^admin_paid:(.+)$/, async (ctx) => {
        if (!isAdmin(ctx.from!.id)) return;
        const orderId = ctx.match![1];
        const order = orders.find(o => o.id === orderId);
        if (!order) {
            await ctx.answerCallbackQuery({ text: "Заказ не найден", show_alert: true });
            return;
        }
        order.payStatus = "paid";
        for (const sid of order.seatIds) {
            const seat = seats.find(s => s.id === sid);
            if (seat) seat.status = "paid";
        }
        await Promise.all([writeJson(ORDERS_FILE, orders), writeJson(SEATS_FILE, seats)]);
        await ctx.answerCallbackQuery({ text: `Оплачен ${orderId}` });
        await ctx.editMessageText(`✅ Оплачен ${orderId}`);
    });


    // capture last 4 digits
    bot.on("message:text", async (ctx) => {
        if (ctx.session.stage !== "await_payment" || !ctx.session.orderId) return;
        const last4 = ctx.message.text.trim();
        if (!/^\d{4}$/.test(last4)) return ctx.reply("Нужно ввести ровно 4 цифры.");

        const order = orders.find((o) => o.id === ctx.session.orderId);
        if (!order) return ctx.reply("Не найден заказ.");
        order.last4 = last4;
        order.payStatus = "paid"; // MANUAL APPROVAL might be later, for now trust user
        await writeJson(ORDERS_FILE, orders);

        // Mark seats paid
        order.seatIds.forEach((id) => {
            const seat = seats.find((s) => s.id === id);
            if (seat) seat.status = "paid";
        });
        await writeJson(SEATS_FILE, seats);

        ctx.session = { stage: "idle" };

        await ctx.reply(`Спасибо! Оплата получена. Ждём вас на сеансе.`);
    });

    /*****************************************************************
     * Launch
     *****************************************************************/

    bot.catch((err) => console.error(err));

    bot.start();

    console.log("▶️  Bot started");

})();
