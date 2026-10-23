// ----------------------------------------------------------------------------
//  שליחה חד-פעמית לכל מי שנטש עגלה בעבר 📣
//  - מזהה מגדר לפי שם פרטי (Claude) ובוחר תבנית: נקבה / זכר / ניטרלי (כשלא בטוחים).
//  - מדלג על מי שכבר קנה, על עגלות בלי טלפון, וממזג כפילויות לפי טלפון.
//  - מתוזמן ל-BACKLOG_SEND_AT (ISO, UTC). שליחה אמיתית רק אם BACKLOG_LIVE=true,
//    אחרת רק רושם ללוג מה היה נשלח.
// ----------------------------------------------------------------------------
import { anthropic, MODEL } from "./claude.js";
import { sendWhatsAppTemplate } from "./whatsapp.js";
import { saveTurn, hasHistory } from "./conversations.js";
import { logToSheet } from "./sheets.js";
import {
  shopifyGraphQL,
  hasOrderedSince,
  hasBought,
  pickContact,
  sentPhones,
  persistState,
} from "./abandoned-cart.js";

const TEMPLATES = { f: "cart_backlog_f", m: "cart_backlog_m", u: "cart_backlog_u" };
const MIN_AGE_MIN = 60; // עגלות צעירות משעה מטופלות בזרימה הרגילה
const PRODUCT_URL = "https://trymiloa.com/products/snoring-by-miloa";

// נוסח התבניות כפי שהוגשו ל-Meta (להזרעת היסטוריית השיחה). חייב להתאים לתבניות המאושרות.
export function renderBacklogText(variant, name, url) {
  const refund =
    variant === "f"
      ? "אם לא תראי תוצאות, תקבלי החזר כספי מלא"
      : variant === "m"
        ? "אם לא תראה תוצאות, תקבל החזר כספי מלא"
        : "אם לא תראו תוצאות, מקבלים החזר כספי מלא";
  const pitch = variant === "u" ? "אז לא כדאי לפספס!" : "אז לא כדאי לך לפספס!";
  return (
    `היי ${name}, זה רועי מ-Miloa 👋😊\n\n` +
    `שמתי לב שההזמנה שלך לסד נגד נחירות נעצרה באמצע, ורציתי לעדכן שההנחה באתר נגמרת היום ב-23:59 ⏰ ${pitch}\n\n` +
    `וגם אני מזכיר שיש 60 לילות ניסיון: ${refund} 💯 ככה שאין שום סיכון!\n\n` +
    `קישור להשלמת ההזמנה 👇\n${url}\n\n` +
    `אם יש לך שאלות, אשמח לענות כמה שיותר מהר על כל מה שצריך 🙏`
  );
}

// ---------------------------------------------------------------------------
//  זיהוי מגדר לפי שם פרטי. כל ספק → "u" (ניסוח ניטרלי) כדי לא לטעות.
// ---------------------------------------------------------------------------
export async function classifyGenders(names) {
  const unique = [...new Set(names.filter(Boolean))];
  const result = new Map(unique.map((n) => [n, "u"]));
  if (!unique.length) return result;
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system:
        "אתה מסווג שמות פרטיים (עבריים/ערביים/לועזיים, כפי שנכתבו בטופס הזמנה בישראל) לפי המגדר הסביר של האדם. " +
        'החזר JSON בלבד: אובייקט שבו המפתח הוא השם בדיוק כפי שהתקבל והערך הוא "f" (שם של אישה), "m" (שם של גבר) או "u". ' +
        'השתמש ב-"u" לשמות שמתאימים לשני המינים (כמו נועם, גל, שחר, טל, יובל, רון), לשמות לא ברורים, ולכל דבר שאינו שם פרטי (כמו "בתי", "אמא", כינוי). ' +
        "אל תנחש: כשיש ספק, תחזיר u.",
      messages: [{ role: "user", content: JSON.stringify(unique) }],
    });
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    for (const n of unique) if (["f", "m", "u"].includes(json[n])) result.set(n, json[n]);
  } catch (err) {
    console.error("שגיאה בזיהוי מגדר — משתמשים בניסוח ניטרלי לכולם:", err.message);
  }
  return result;
}

const cleanName = (raw) =>
  String(raw || "")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .split(/\s+/)[0] || "";

// ---------------------------------------------------------------------------
//  בניית רשימת הנמענים
// ---------------------------------------------------------------------------
const ALL_CHECKOUTS_QUERY = `query($after: String) {
  abandonedCheckouts(first: 100, after: $after, reverse: true) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      id createdAt completedAt abandonedCheckoutUrl
      customer { firstName email phone }
      billingAddress { firstName phone }
      shippingAddress { firstName phone }
    } }
  }
}`;

export async function buildRecipients() {
  const nodes = [];
  let after = null;
  do {
    const data = await shopifyGraphQL(ALL_CHECKOUTS_QUERY, { after });
    nodes.push(...data.abandonedCheckouts.edges.map((e) => e.node));
    const pi = data.abandonedCheckouts.pageInfo;
    after = pi.hasNextPage ? pi.endCursor : null;
  } while (after);

  const now = Date.now();
  const byPhone = new Map(); // הכי חדשה לכל טלפון (הרשימה כבר מהחדשה לישנה)
  const stats = { total: nodes.length, completed: 0, noPhone: 0, tooYoung: 0, ordered: 0, recent: 0 };

  for (const node of nodes) {
    if (node.completedAt || !node.abandonedCheckoutUrl) {
      stats.completed++;
      continue;
    }
    const { phone, firstName, email } = pickContact(node);
    if (!phone) {
      stats.noPhone++;
      continue;
    }
    if ((now - new Date(node.createdAt).getTime()) / 60000 < MIN_AGE_MIN) {
      stats.tooYoung++;
      continue;
    }
    if (byPhone.has(phone)) continue;
    byPhone.set(phone, { phone, firstName: cleanName(firstName), email, url: node.abandonedCheckoutUrl, createdAt: node.createdAt });
  }

  const candidates = [];
  for (const r of byPhone.values()) {
    const last = sentPhones.get(r.phone);
    if (hasHistory(r.phone) || (last && now - last < 24 * 60 * 60 * 1000)) {
      stats.recent++;
      continue;
    }
    if ((await hasBought(r.phone, r.email)) || (await hasOrderedSince(r.email, r.createdAt))) {
      stats.ordered++;
      continue;
    }
    candidates.push(r);
  }

  const genders = await classifyGenders(candidates.map((r) => r.firstName));
  const recipients = candidates.map((r) => ({
    ...r,
    name: r.firstName || "חבר/ה",
    variant: r.firstName ? genders.get(r.firstName) ?? "u" : "u",
  }));
  return { recipients, stats };
}

// ---------------------------------------------------------------------------
//  שליחה
// ---------------------------------------------------------------------------
async function sendOne({ phone, name, variant, url }) {
  const text = renderBacklogText(variant, name, url);
  await sendWhatsAppTemplate(phone, TEMPLATES[variant], [name, url]);
  saveTurn(
    phone,
    "[הודעת מערכת: הלקוח נטש עגלה באתר בעבר. נשלחה לו הודעת תזכורת בוואטסאפ עם קישור להשלמת ההזמנה.]",
    text
  );
  logToSheet({ name, phone, userMessage: "[תזכורת עגלה נטושה — שליחה חד-פעמית]", botReply: text });
}

const mask = (phone) => `***${phone.slice(-4)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** מצב בדיקה: בונה את הרשימה ומחזיר סיכום (ללא מספרים מלאים), בלי לשלוח. */
export async function previewBacklog() {
  const { recipients, stats } = await buildRecipients();
  const byVariant = { f: 0, m: 0, u: 0 };
  recipients.forEach((r) => byVariant[r.variant]++);
  return {
    stats,
    willSend: recipients.length,
    byVariant,
    list: recipients.map((r) => ({ phone: mask(r.phone), name: r.name, variant: r.variant })),
  };
}

/** שליחת בדיקה למספר אחד (עם קישור לדף המוצר במקום קישור צ'קאאוט). */
export async function sendBacklogTest(phone, rawName) {
  const name = cleanName(rawName) || "חבר/ה";
  const variant = (await classifyGenders([name])).get(name) ?? "u";
  await sendOne({ phone, name, variant, url: PRODUCT_URL });
  return { variant, template: TEMPLATES[variant] };
}

let backlogDone = false;

export async function runBacklog({ live }) {
  const { recipients, stats } = await buildRecipients();
  console.log(`📣 שליחה חד-פעמית: ${recipients.length} נמענים`, JSON.stringify(stats));
  let sent = 0;
  for (const r of recipients) {
    if (!live) {
      console.log(`🧪 [DRY RUN] ${mask(r.phone)} (${r.name}, ${r.variant})`);
      continue;
    }
    try {
      await sendOne(r);
      sentPhones.set(r.phone, Date.now());
      persistState();
      sent++;
      console.log(`📣 נשלח ל-${mask(r.phone)} (${r.variant})`);
    } catch (err) {
      console.error(`❌ כשל בשליחה ל-${mask(r.phone)}:`, err.message);
    }
    await sleep(1500);
  }
  console.log(`📣 הסתיים: ${sent}/${recipients.length} נשלחו${live ? "" : " (DRY RUN)"}`);
}

/** מתזמן את השליחה החד-פעמית ל-BACKLOG_SEND_AT (חלון של 30 דקות, פעם אחת). */
export function startBacklogScheduler() {
  const at = Date.parse(process.env.BACKLOG_SEND_AT || "");
  if (!at) return;
  const live = String(process.env.BACKLOG_LIVE ?? "false").toLowerCase() === "true";
  console.log(`📣 שליחה חד-פעמית מתוזמנת ל-${new Date(at).toISOString()} — ${live ? "מצב חי" : "DRY RUN"}`);

  setInterval(async () => {
    const now = Date.now();
    if (backlogDone || now < at || now > at + 30 * 60 * 1000) return;
    backlogDone = true;
    try {
      await runBacklog({ live });
    } catch (err) {
      console.error("שגיאה בשליחה החד-פעמית:", err.message);
    }
  }, 30 * 1000);
}
