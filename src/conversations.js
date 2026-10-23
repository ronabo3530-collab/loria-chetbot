// ----------------------------------------------------------------------------
//  זיכרון שיחה — נשמר בזיכרון (RAM) לפי מספר טלפון.
//  שומרים חלון של ההודעות האחרונות בלבד כדי לחסוך בעלות ובזמן.
//  ⚠️ בהפעלה מחדש של השרת הזיכרון מתאפס. לשלב מתקדם אפשר להחליף ל-Redis/DB.
//  מודול משותף: גם השרת (תשובות ללקוחות) וגם שליחת תזכורות עגלה נטושה משתמשים בו.
// ----------------------------------------------------------------------------
const conversations = new Map();
const MAX_HISTORY = 10; // מספר ההודעות האחרונות שנשמרות (user+assistant)

export function getHistory(phone) {
  return conversations.get(phone) ?? [];
}

export function saveTurn(phone, userText, botText) {
  const history = getHistory(phone);
  history.push({ role: "user", content: userText });
  history.push({ role: "assistant", content: botText });
  // שומרים רק את החלון האחרון
  conversations.set(phone, history.slice(-MAX_HISTORY));
}

export function hasHistory(phone) {
  return getHistory(phone).length > 0;
}
