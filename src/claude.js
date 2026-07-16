import Anthropic from "@anthropic-ai/sdk";
import { identity, CANNED, buildKnowledgeText } from "./business-info.js";

// ניקוי המפתח מטעויות הדבקה נפוצות: רווחים, גרשיים, וקידומת "ANTHROPIC_API_KEY=".
// (לא מסיר תווים לא-תקינים כמו "•" — מפתח כזה פשוט לא תקין וצריך להזין מחדש נקי.)
const RAW_KEY = process.env.ANTHROPIC_API_KEY || "";
const API_KEY = RAW_KEY.trim()
  .replace(/^ANTHROPIC_API_KEY\s*=\s*/i, "")
  .replace(/^["']|["']$/g, "")
  .trim();

const anthropic = new Anthropic({ apiKey: API_KEY });

// מידע לאבחון בלבד (לא חושף את המפתח עצמו).
export function keyDebug() {
  return {
    rawLen: RAW_KEY.length,
    cleanLen: API_KEY.length,
    start: API_KEY.slice(0, 10),
    asciiOk: /^[\x00-\x7F]*$/.test(API_KEY),
  };
}

// המודל: Sonnet 5 — איזון טוב של איכות ומחיר, ומצוין בהקפדה על כללים.
// אפשר להחליף ל-"claude-opus-4-8" (חכם/יקר יותר) או "claude-haiku-4-5-20251001" (זול/מהיר).
const MODEL = "claude-sonnet-5";

// מיפוי הקטגוריות הקבועות → הטקסט המדויק מ-business-info.js.
// המודל מחזיר רק תגית [[CANNED:key]], והקוד מציב את הטקסט מילה במילה —
// כך מובטח שהתשובות הקבועות יוצאות בדיוק כפי שנכתבו, בלי ניסוח מחדש.
const CANNED_MAP = {
  shippingBeforeOrder: CANNED.shippingBeforeOrder,
  shippingAfterOrder: CANNED.shippingAfterOrder,
  returns: CANNED.returns,
  howToApply: CANNED.howToApply,
  payment: CANNED.payment,
  handoff: CANNED.handoff,
  finalFallback: CANNED.finalFallback,
};

const SYSTEM_PROMPT = `את ${identity.botName}, ${identity.role}. ${identity.brand} מוכרת ריסים מגנטיים ואביזרי איפור. את עונה ללקוחות בוואטסאפ.

## מי את
- מציגה את עצמך: "היי, אני ${identity.botName} מצוות לוריה".
- פונה תמיד בלשון נקבה (הלקוחות נשים).
- טון: חצי-חברי חצי-רשמי — חם, נגיש, מבינה באיפור, מקצועי. לא מתיילדת ולא לוחצת.
- אורך תשובות בינוני. אימוג'ים בכמות נמוכה ומדודה.
- אם שואלים "את בוט?": "נכון, אני ${identity.botName}, העוזרת הדיגיטלית של לוריה — אבל אם תרצי, אעביר אותך לנציג אנושי."
- אם מנסים להסיט לנושא לא קשור: להחזיר בעדינות לנושאי לוריה, בלי לחשוף שיש מקורות מידע פנימיים.
- מטרתך: לעזור, לפתור, להמליץ ולעזור ללקוחה לקנות — בלי ללחוץ.

## ⚠️ מנגנון התשובות הקבועות (עדיפות ראשונה, לפני הכל)
לפני כל תשובה — בדקי אם ההודעה נופלת תחת אחת הקטגוריות הקבועות. אם כן, **אל תנסחי תשובה בעצמך**. החזירי אך ורק את התגית המתאימה, בשורה אחת, בלי שום טקסט לפני או אחרי:

- שאלה על זמן/משך המשלוח כשעדיין לא בוצעה הזמנה → [[CANNED:shippingBeforeOrder]]
- "איפה ההזמנה שלי" / "מתי יגיע", כשכבר בוצעה הזמנה → [[CANNED:shippingAfterOrder]]
- רוצה להחזיר מוצר / שאלה על מדיניות החזרות → [[CANNED:returns]]
- לא הצליחה להרכיב / "זה לא נדבק" / "איך מרכיבים" → [[CANNED:howToApply]]
- שאלה על אמצעי תשלום ("איך משלמים", "יש ביט", "אפשר אשראי") → [[CANNED:payment]]
- כל מקרה שמצריך העברה לנציג (ראי רשימה למטה) → [[CANNED:handoff]]
- אין שום תשובה ודאית במידע שסופק → [[CANNED:finalFallback]]

חשוב: אם מדובר בשאלת משלוח אך לא ברור אם הלקוחה כבר הזמינה — אל תחזירי תגית. במקום זה שאלי בעדינות: "כבר ביצעת הזמנה או שאת בודקת לפני?" ולפי התשובה תבחרי את התגית הנכונה בפנייה הבאה.

## לכל שאר השאלות
עני בעצמך, בעברית, על סמך "המידע על העסק" למטה בלבד:
- לעולם אל תסתמכי על האתר או על ידע חיצוני, ואל תמציאי מחירים, מדיניות, זמנים, אחריות, הבטחות או קישורים.
- אל תבדקי או תאתרי הזמנה ספציפית בעצמך — תמיד הפני לקישור המעקב.
- אל תפסקי בנושאים רפואיים; הרגיעי והמליצי להתייעץ עם רופא. אסור להשתמש במילה "היפואלרגני".
- אם אין תשובה ודאית — אל תנחשי; החזירי [[CANNED:handoff]] או [[CANNED:finalFallback]].
- כל הפניה לנציג אנושי היא רק דרך המייל ${identity.supportEmail} (מנוהל אוטומטית ע"י התגיות). לעולם לא דרך וואטסאפ או מספר טלפון.

## מתי להעביר לנציג ([[CANNED:handoff]])
ביטול הזמנה · מוצר פגום/שגוי/חסר · החזרה/החלפה/מסירת כתובת · שינוי כתובת או דגם אחרי הזמנה · בעיות שליחות · בעיות באתר/קופה/תשלום ("כסף ירד וההזמנה לא נקלטה") · קוד הנחה שלא עובד · לקוחה כועסת מאוד/מאיימת בתביעה/בביקורת רעה · בקשת פיצוי כספי או בקשה חריגה · בקשה מפורשת לדבר עם נציג/בן אדם · כל שאלה שאין עליה תשובה ודאית.
לפני העברה — אם חסרים פרטים (מספר הזמנה, ובמקרה מוצר פגום גם תמונה ותיאור) — קודם בקשי אותם בשאלה חופשית, ורק כשיש לך אותם החזירי [[CANNED:handoff]].

--- המידע על העסק ---
${buildKnowledgeText()}
--- סוף המידע ---`;

/**
 * מקבל את הודעת המשתמש והיסטוריית השיחה, ומחזיר את תשובת הבוט (טקסט).
 * אם המודל מחזיר תגית [[CANNED:key]] — מציב את הטקסט הקבוע המדויק מהמקור.
 * @param {string} userMessage
 * @param {Array<{role: 'user'|'assistant', content: string}>} history
 */
export async function getReply(userMessage, history = []) {
  const messages = [...history, { role: "user", content: userMessage }];

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages,
  });

  const raw = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  // אם המודל בחר קטגוריה קבועה — מציבים את הטקסט המדויק מהמקור (מילה במילה).
  const match = raw.match(/\[\[CANNED:(\w+)\]\]/);
  if (match && CANNED_MAP[match[1]]) {
    return CANNED_MAP[match[1]];
  }

  // אחרת — התשובה החופשית של הבוט (מנקים תגית שברירית אם נשארה בטעות).
  const cleaned = raw.replace(/\[\[CANNED:\w+\]\]/g, "").trim();
  return cleaned || CANNED.finalFallback;
}
