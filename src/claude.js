import Anthropic from "@anthropic-ai/sdk";
import { identity, SYSTEM_PROMPT } from "./business-info.js";

// ניקוי המפתח מטעויות הדבקה נפוצות: רווחים, גרשיים, וקידומת "ANTHROPIC_API_KEY=".
// (לא מסיר תווים לא-תקינים כמו "•" — מפתח כזה פשוט לא תקין וצריך להזין מחדש נקי.)
const RAW_KEY = process.env.ANTHROPIC_API_KEY || "";
const API_KEY = RAW_KEY.trim()
  .replace(/^ANTHROPIC_API_KEY\s*=\s*/i, "")
  .replace(/^["']|["']$/g, "")
  .trim();

export const anthropic = new Anthropic({ apiKey: API_KEY });

// המודל: Sonnet 5 — איזון טוב של איכות ומחיר, ומצוין בהקפדה על כללים.
// אפשר להחליף ל-"claude-opus-4-8" (חכם/יקר יותר) או "claude-haiku-4-5-20251001" (זול/מהיר).
export const MODEL = "claude-sonnet-5";

// תשובת ברירת מחדל אם המודל החזיר תשובה ריקה.
const EMPTY_REPLY_FALLBACK = `לא הצלחתי לענות על זה כרגע. אפשר לפנות אלינו במייל: ${identity.supportEmail}`;

/**
 * מקבל את הודעת המשתמש והיסטוריית השיחה, ומחזיר את תשובת הבוט (טקסט).
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

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  return text || EMPTY_REPLY_FALLBACK;
}
