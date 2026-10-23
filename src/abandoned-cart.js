// ----------------------------------------------------------------------------
//  שחזור עגלות נטושות 🛒 — רועי פונה בוואטסאפ ללקוחות שהשאירו טלפון ולא סיימו הזמנה.
//
//  איך זה עובד:
//   1. כל כמה דקות שואלים את Shopify (Admin GraphQL) מה הצ'קאאוטים הנטושים האחרונים.
//   2. מי שעברה שעה מהנטישה (ABANDONED_CART_DELAY_MIN), השאיר טלפון ולא קנה — נשלחת לו
//      הודעת תבנית (template) מאושרת של Meta, כי זו הדרך היחידה ליזום שיחה.
//   3. מזריעים את ההודעה להיסטוריית השיחה, כך שכשהלקוח עונה — רועי יודע על מה מדובר
//      וממשיך את השיחה כרגיל (חלון 24 שעות).
//
//  מצב בדיקה: ABANDONED_CART_DRY_RUN=true (ברירת מחדל) — רק רושם ללוג, לא שולח כלום.
//  ⚠️ זיכרון השליחות נשמר בקובץ; בפריסה מחדש ב-Railway הקובץ נמחק, ולכן שולחים רק
//  לעגלות שנטשו בחלון זמן קצר (עד MAX_AGE_MIN) כדי לא לשלוח כפול/ישן.
// ----------------------------------------------------------------------------
import fs from "node:fs";
import { sendWhatsAppTemplate } from "./whatsapp.js";
import { saveTurn, hasHistory } from "./conversations.js";
import { logToSheet } from "./sheets.js";

const SHOP = process.env.SHOPIFY_STORE_DOMAIN;
const CLIENT_ID = (process.env.SHOPIFY_CLIENT_ID || "").trim();
const CLIENT_SECRET = (process.env.SHOPIFY_CLIENT_SECRET || "").trim();
const API_VERSION = "2025-10";

const TEMPLATE_NAME = process.env.ABANDONED_CART_TEMPLATE || "abandoned_cart_miloa";
const DELAY_MIN = Number(process.env.ABANDONED_CART_DELAY_MIN) || 60; // מתי לשלוח (דקות מהנטישה)
const MAX_AGE_MIN = Number(process.env.ABANDONED_CART_MAX_AGE_MIN) || 180; // אחרי זה כבר לא שולחים
const POLL_MS = 5 * 60 * 1000;
const DRY_RUN = String(process.env.ABANDONED_CART_DRY_RUN ?? "true").toLowerCase() !== "false";
const STATE_FILE = process.env.ABANDONED_CART_STATE_FILE || "./abandoned-state.json";

// נוסח התבנית כפי שהוגשה ל-Meta — משמש להזרעת היסטוריית השיחה. חייב להתאים לתבנית המאושרת.
function renderTemplateText(firstName, url) {
  return (
    `היי ${firstName}, זה רועי מ-MILOA 🙂\n` +
    `ראיתי שהשארת בעגלה את הסד נגד נחירות ולא סיימת את ההזמנה. אפשר להשלים אותה כאן: ${url}\n` +
    `יש שאלות? אפשר פשוט לענות כאן ואני אעזור.`
  );
}

// ---------------------------------------------------------------------------
//  זיכרון שליחות (כדי לא לשלוח פעמיים לאותה עגלה / לאותו מספר)
// ---------------------------------------------------------------------------
export const sentCheckouts = new Set();
export const sentPhones = new Map(); // phone -> timestamp של השליחה האחרונה

try {
  const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  (saved.checkouts ?? []).forEach((id) => sentCheckouts.add(id));
  Object.entries(saved.phones ?? {}).forEach(([p, t]) => sentPhones.set(p, t));
} catch {
  // אין קובץ עדיין — מתחילים נקי
}

export function persistState() {
  try {
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    for (const [p, t] of sentPhones) if (t < cutoff) sentPhones.delete(p);
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ checkouts: [...sentCheckouts].slice(-500), phones: Object.fromEntries(sentPhones) })
    );
  } catch (err) {
    console.error("שגיאה בשמירת מצב עגלות נטושות:", err.message);
  }
}

// ---------------------------------------------------------------------------
//  Shopify
// ---------------------------------------------------------------------------
let cachedToken = null;
let tokenExpiresAt = 0;

async function getShopifyToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60 * 60 * 1000) return cachedToken;
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Shopify token error: ${res.status}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in ?? 86400) * 1000;
  return cachedToken;
}

export async function shopifyGraphQL(query, variables = {}) {
  const token = await getShopifyToken();
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify GraphQL error: ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(json.errors).slice(0, 300)}`);
  return json.data;
}

const CHECKOUTS_QUERY = `{
  abandonedCheckouts(first: 50, reverse: true) {
    edges { node {
      id createdAt completedAt abandonedCheckoutUrl
      customer { firstName email phone }
      billingAddress { firstName phone }
      shippingAddress { firstName phone }
    } }
  }
}`;

const ORDERS_QUERY = `query($q: String!) { orders(first: 1, query: $q) { edges { node { id } } } }`;

const BUYERS_QUERY = `query($after: String) {
  orders(first: 250, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      email phone
      customer { email phone }
      shippingAddress { phone }
      billingAddress { phone }
    } }
  }
}`;

// כל מי שהזמין (לפי טלפון/מייל) — כדי לא לשלוח "השלם הזמנה" למי שכבר קנה, גם בצ'קאאוט אחר.
// ⚠️ ההרשאה read_orders מחזירה הזמנות מ-60 הימים האחרונים בלבד.
let buyersCache = null;
export async function fetchBuyers() {
  if (buyersCache && Date.now() - buyersCache.at < 10 * 60 * 1000) return buyersCache;
  const phones = new Set();
  const emails = new Set();
  let after = null;
  do {
    const data = await shopifyGraphQL(BUYERS_QUERY, { after });
    for (const { node } of data.orders.edges) {
      [node.phone, node.customer?.phone, node.shippingAddress?.phone, node.billingAddress?.phone]
        .map(normalizePhone)
        .filter(Boolean)
        .forEach((p) => phones.add(p));
      [node.email, node.customer?.email].filter(Boolean).forEach((e) => emails.add(e.toLowerCase()));
    }
    const pi = data.orders.pageInfo;
    after = pi.hasNextPage ? pi.endCursor : null;
  } while (after);
  buyersCache = { at: Date.now(), phones, emails };
  return buyersCache;
}

export async function hasBought(phone, email) {
  const b = await fetchBuyers();
  return b.phones.has(phone) || (email ? b.emails.has(email.toLowerCase()) : false);
}

export async function hasOrderedSince(email, sinceIso) {
  if (!email) return false;
  const data = await shopifyGraphQL(ORDERS_QUERY, { q: `email:${email} created_at:>=${sinceIso}` });
  return data.orders.edges.length > 0;
}

// ---------------------------------------------------------------------------
//  עזרים
// ---------------------------------------------------------------------------
// ממיר טלפון (05X..., +972..., 972...) לפורמט של וואטסאפ: 972XXXXXXXXX. מחזיר null אם לא תקין.
export function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/[^\d]/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("972")) {
    // 9720...? מסירים 0 מיותר אחרי הקידומת
    if (digits[3] === "0") digits = "972" + digits.slice(4);
  } else if (digits.startsWith("0")) {
    digits = "972" + digits.slice(1);
  } else if (digits.length === 9 && digits.startsWith("5")) {
    digits = "972" + digits;
  } else if (!String(raw).trim().startsWith("+")) {
    return null; // לא ברור איזה מדינה — לא מנחשים
  }
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

export function pickContact(node) {
  const phone = [node.customer?.phone, node.shippingAddress?.phone, node.billingAddress?.phone]
    .map(normalizePhone)
    .find(Boolean);
  const firstName = (node.customer?.firstName || node.shippingAddress?.firstName || node.billingAddress?.firstName || "")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return { phone, firstName, email: node.customer?.email ?? null };
}

// ---------------------------------------------------------------------------
//  הסריקה
// ---------------------------------------------------------------------------
async function scanOnce() {
  const data = await shopifyGraphQL(CHECKOUTS_QUERY);
  const now = Date.now();
  let candidates = 0;

  for (const { node } of data.abandonedCheckouts.edges) {
    if (node.completedAt || sentCheckouts.has(node.id) || !node.abandonedCheckoutUrl) continue;

    const ageMin = (now - new Date(node.createdAt).getTime()) / 60000;
    if (ageMin < DELAY_MIN || ageMin >= MAX_AGE_MIN) continue;

    const { phone, firstName, email } = pickContact(node);
    if (!phone) continue;

    candidates++;
    // לא כותבים לאותו מספר פעמיים ביממה, ולא מפריעים למי שכבר משוחח עם רועי.
    const lastSent = sentPhones.get(phone);
    if (hasHistory(phone) || (lastSent && now - lastSent < 24 * 60 * 60 * 1000)) {
      sentCheckouts.add(node.id);
      continue;
    }
    // אם כבר הזמין (בצ'קאאוט אחר) מאז — לא צריך תזכורת.
    if ((await hasBought(phone, email)) || (await hasOrderedSince(email, node.createdAt))) {
      sentCheckouts.add(node.id);
      continue;
    }

    const name = firstName || "חבר/ה";
    const text = renderTemplateText(name, node.abandonedCheckoutUrl);

    if (DRY_RUN) {
      // ללא מספר מלא בלוג — פרטיות
      console.log(`🧪 [DRY RUN] הייתי שולח תזכורת עגלה ל-***${phone.slice(-4)} (${name}), גיל עגלה ${Math.round(ageMin)} דק'`);
      continue; // לא מסמנים כנשלח, כדי שיופיע שוב בסריקה הבאה בבדיקה
    }

    sentCheckouts.add(node.id);
    sentPhones.set(phone, now);
    persistState();
    try {
      await sendWhatsAppTemplate(phone, TEMPLATE_NAME, [name, node.abandonedCheckoutUrl]);
      saveTurn(
        phone,
        "[הודעת מערכת: הלקוח השאיר עגלה באתר ולא השלים הזמנה. נשלחה לו תזכורת בוואטסאפ.]",
        text
      );
      console.log(`🛒 נשלחה תזכורת עגלה נטושה ל-***${phone.slice(-4)}`);
      logToSheet({ name, phone, userMessage: "[תזכורת עגלה נטושה]", botReply: text });
    } catch (err) {
      console.error(`❌ כשל בשליחת תזכורת עגלה ל-***${phone.slice(-4)}:`, err.message);
    }
  }

  if (DRY_RUN) console.log(`🧪 [DRY RUN] סריקת עגלות נטושות הסתיימה — ${candidates} מועמדות בחלון הזמן`);
}

export function startAbandonedCartRecovery() {
  if (!SHOP || !CLIENT_ID || !CLIENT_SECRET) {
    console.log("ℹ️ שחזור עגלות נטושות כבוי (חסרים משתני Shopify)");
    return;
  }
  console.log(
    `🛒 שחזור עגלות נטושות פעיל — ${DRY_RUN ? "מצב בדיקה (DRY RUN, לא שולח)" : "מצב חי"}, ` +
      `שליחה אחרי ${DELAY_MIN} דק', תבנית: ${TEMPLATE_NAME}`
  );

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await scanOnce();
    } catch (err) {
      console.error("שגיאה בסריקת עגלות נטושות:", err.message);
    } finally {
      running = false;
    }
  };

  setTimeout(tick, 30 * 1000);
  setInterval(tick, POLL_MS);
}
