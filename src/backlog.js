// ----------------------------------------------------------------------------
//  שליחה חד-פעמית לעגלות נטושות מהשבוע האחרון 📣
//  - שולחת את תבנית החזייה (bra_cart_recovery) למי שנטשה עגלה עם החזייה לפני יותר משעה
//    ופחות מ-BACKLOG_MAX_AGE_DAYS ימים (ברירת מחדל 7), ושעוד לא קיבלה הודעה.
//  - מדלגת על מי שכבר קנתה, על עגלות בלי טלפון, וממזגת כפילויות לפי טלפון.
//  - מתוזמנת ל-BACKLOG_SEND_AT (ISO, UTC), חלון של 30 דקות. שליחה אמיתית רק אם
//    BACKLOG_LIVE=true, אחרת רק רושמת ללוג מה היה נשלח.
// ----------------------------------------------------------------------------
import { hasHistory } from "./conversations.js";
import {
  shopifyGraphQL,
  hasOrderedSince,
  hasBought,
  hasProduct,
  pickContact,
  sendCartReminder,
  FALLBACK_NAME,
  sentPhones,
  persistState,
} from "./abandoned-cart.js";

const MIN_AGE_MIN = 60; // עגלות צעירות משעה מטופלות בזרימה השוטפת
const MAX_AGE_DAYS = Number(process.env.BACKLOG_MAX_AGE_DAYS) || 7;
const PRODUCT_URL = "https://trymiloa.com/products/miloa-posture-support-bra";

const cleanName = (raw) =>
  String(raw || "")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .split(/\s+/)[0] || "";

// ---------------------------------------------------------------------------
//  בניית רשימת הנמענים
// ---------------------------------------------------------------------------
const CHECKOUTS_QUERY = `query($after: String) {
  abandonedCheckouts(first: 100, after: $after, reverse: true) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      id createdAt completedAt abandonedCheckoutUrl
      lineItems(first: 10) { edges { node { title } } }
      customer { firstName email phone }
      billingAddress { firstName phone }
      shippingAddress { firstName phone }
    } }
  }
}`;

export async function buildRecipients({ maxAgeDays = MAX_AGE_DAYS } = {}) {
  const nodes = [];
  let after = null;
  do {
    const data = await shopifyGraphQL(CHECKOUTS_QUERY, { after });
    nodes.push(...data.abandonedCheckouts.edges.map((e) => e.node));
    const pi = data.abandonedCheckouts.pageInfo;
    after = pi.hasNextPage ? pi.endCursor : null;
  } while (after);

  const now = Date.now();
  const stats = { total: nodes.length, tooOld: 0, otherProduct: 0, completed: 0, noPhone: 0, tooYoung: 0, bought: 0, recent: 0 };
  const byPhone = new Map(); // הכי חדשה לכל טלפון (הרשימה כבר מהחדשה לישנה)

  for (const node of nodes) {
    const ageMin = (now - new Date(node.createdAt).getTime()) / 60000;
    if (ageMin > maxAgeDays * 24 * 60) {
      stats.tooOld++;
      continue;
    }
    if (node.completedAt || !node.abandonedCheckoutUrl) {
      stats.completed++;
      continue;
    }
    if (!hasProduct(node)) {
      stats.otherProduct++;
      continue;
    }
    const { phone, firstName, email } = pickContact(node);
    if (!phone) {
      stats.noPhone++;
      continue;
    }
    if (ageMin < MIN_AGE_MIN) {
      stats.tooYoung++;
      continue;
    }
    if (byPhone.has(phone)) continue;
    byPhone.set(phone, { phone, firstName: cleanName(firstName), email, url: node.abandonedCheckoutUrl, createdAt: node.createdAt });
  }

  const recipients = [];
  for (const r of byPhone.values()) {
    const last = sentPhones.get(r.phone);
    if (hasHistory(r.phone) || (last && now - last < 24 * 60 * 60 * 1000)) {
      stats.recent++;
      continue;
    }
    if ((await hasBought(r.phone, r.email)) || (await hasOrderedSince(r.email, r.createdAt))) {
      stats.bought++;
      continue;
    }
    recipients.push({ ...r, name: r.firstName || FALLBACK_NAME });
  }
  return { recipients, stats };
}

// ---------------------------------------------------------------------------
//  שליחה
// ---------------------------------------------------------------------------
async function sendOne({ phone, name, url }) {
  return sendCartReminder(phone, name, url);
}

const mask = (phone) => `***${phone.slice(-4)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** מצב בדיקה: בונה את הרשימה ומחזיר סיכום (ללא מספרים מלאים), בלי לשלוח. */
export async function previewBacklog(opts) {
  const { recipients, stats } = await buildRecipients(opts);
  return {
    stats,
    willSend: recipients.length,
    list: recipients.map((r) => ({ phone: mask(r.phone), name: r.name })),
  };
}

/** שליחת בדיקה למספר אחד (עם קישור לדף המוצר במקום קישור צ'קאאוט). */
export async function sendBacklogTest(phone, rawName) {
  const name = cleanName(rawName) || FALLBACK_NAME;
  const { template } = await sendOne({ phone, name, url: PRODUCT_URL });
  return { template };
}

let backlogDone = false;
let backlogRunning = false;

export async function runBacklog({ live, maxAgeDays }) {
  if (backlogRunning) return console.log("📣 שליחה חד-פעמית כבר רצה — מדלג");
  backlogRunning = true;
  try {
    await runBacklogInner({ live, maxAgeDays });
  } finally {
    backlogRunning = false;
  }
}

async function runBacklogInner({ live, maxAgeDays }) {
  const { recipients, stats } = await buildRecipients({ maxAgeDays });
  console.log(`📣 שליחה חד-פעמית: ${recipients.length} נמענות`, JSON.stringify(stats));
  let sent = 0;
  for (const r of recipients) {
    if (!live) {
      console.log(`🧪 [DRY RUN] ${mask(r.phone)} (${r.name})`);
      continue;
    }
    try {
      await sendOne(r);
      sentPhones.set(r.phone, Date.now());
      persistState();
      sent++;
      console.log(`📣 נשלח ל-${mask(r.phone)}`);
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
