# 💬 ליאור — צ'אטבוט וואטסאפ של לוריה (Loria)

"ליאור", העוזרת הדיגיטלית של לוריה — בוט חכם מבוסס **Claude** שעונה ללקוחות בוואטסאפ על שאלות נפוצות ונותן ייעוץ על ריסים מגנטיים, 24/7, בעברית טבעית ובלשון נקבה. בסיס הידע כבר מלא בפרטי לוריה (מוצרים, מחירים, מדיניות ותשובות קבועות).

---

## 📁 מבנה הפרויקט

```
src/
  server.js         ← השרת הראשי (מקבל הודעות מוואטסאפ ומחזיר תשובות)
  whatsapp.js       ← שליחה/קבלה של הודעות מול WhatsApp Cloud API
  claude.js         ← החיבור ל-Claude וה"אישיות" של הבוט
  business-info.js  ← 📌 בסיס הידע של לוריה — מוצרים, מחירים, מדיניות והתשובות הקבועות
  test-claude.js    ← סקריפט בדיקה מהיר
.env.example        ← תבנית להגדרת הסודות
```

**בסיס הידע כבר מלא** בפרטי לוריה. כדי לעדכן מחירים/מוצרים/תשובות בעתיד — עורכים את `src/business-info.js` (התשובות הקבועות נמצאות באובייקט `CANNED`) ופורסים מחדש. כל מה שכתוב שם — הבוט יודע; מה שלא — הוא מפנה את הלקוחה למייל `shopbyloria@gmail.com` במקום להמציא.

---

## 🚀 מדריך הקמה — צעד אחר צעד

יש 5 שלבים. אני (Claude Code) לא יכול ליצור עבורך חשבונות או להזין סיסמאות, אבל הכול מוסבר כאן בפירוט.

### שלב 1 — מפתח Claude API 🔑
1. היכנס/י ל-[console.anthropic.com](https://console.anthropic.com).
2. הירשם/הירשמי או התחבר/י.
3. תפריט **API Keys** → **Create Key** → העתק/י את המפתח (מתחיל ב-`sk-ant-`).
4. בתפריט **Billing** טען/י קרדיט (הבוט זול מאוד לשימוש — סנטים לשיחה).

> שמור/י את המפתח בצד — נזין אותו בשלב 3.

### שלב 2 — WhatsApp Cloud API 📱
1. היכנס/י ל-[developers.facebook.com](https://developers.facebook.com) עם חשבון ה-Meta Business שלך.
2. **My Apps** → **Create App** → בחר/י סוג **Business** → תן/י שם.
3. במסך האפליקציה, הוסף/י את המוצר **WhatsApp** (Set up).
4. במסך **API Setup** תמצא/י:
   - **Phone number ID** (מספר) → זה ה-`WHATSAPP_PHONE_NUMBER_ID`.
   - **Temporary access token** → זה ה-`WHATSAPP_TOKEN` (לבדיקות; ראה/י הערה למטה).
5. תחת **"To"** הוסף/י את מספר הטלפון שלך כדי לבדוק (בשלב הפיתוח מותר לשלוח רק למספרים מאושרים).

> ⚠️ **הטוקן הזמני תקף ל-24 שעות בלבד.** לפני העלייה לאוויר קבוע, צור/צרי טוקן קבוע דרך **System User** ב-[business.facebook.com](https://business.facebook.com) → Settings → Users → System Users. (מוסבר בהמשך, אפשר לעשות אחרי שהכול עובד.)

### שלב 3 — פריסה לענן ☁️ (Railway)
כדי שוואטסאפ יוכל "לדבר" עם הבוט, הוא צריך כתובת אינטרנט ציבורית וקבועה.

1. העלה/י את הקוד לגיטהאב (או השתמש/י באפשרות "Deploy from local").
2. היכנס/י ל-[railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** ובחר/י את הפרויקט.
3. Railway יזהה אוטומטית Node.js ויריץ `npm start`.
4. תחת **Variables** הוסף/י את משתני הסביבה (מתוך `.env.example`):
   - `ANTHROPIC_API_KEY` — מפתח Claude משלב 1
   - `WHATSAPP_TOKEN` — הטוקן משלב 2
   - `WHATSAPP_PHONE_NUMBER_ID` — משלב 2
   - `VERIFY_TOKEN` — **מחרוזת סודית שאת/ה בוחר/ת** (למשל `lashes-bot-2026`) — נצטרך אותה בשלב 4
5. תחת **Settings → Networking → Generate Domain** קבל/י כתובת ציבורית, למשל:
   `https://your-bot.up.railway.app`

> אפשר גם [Render](https://render.com) באותו עיקרון (בחר/י Web Service, Build: `npm install`, Start: `npm start`).

### שלב 4 — חיבור ה-Webhook ב-Meta 🔗
1. חזור/חזרי ל-[developers.facebook.com](https://developers.facebook.com) → האפליקציה → **WhatsApp → Configuration**.
2. תחת **Webhook** לחץ/י **Edit** והזן/י:
   - **Callback URL:** `https://your-bot.up.railway.app/webhook` (הכתובת משלב 3 + `/webhook`)
   - **Verify token:** בדיוק אותה מחרוזת שהגדרת ב-`VERIFY_TOKEN`
3. לחץ/י **Verify and Save** — אם הכול תקין, זה יאושר בירוק ✅.
4. תחת **Webhook fields** לחץ/י **Manage** וסמן/י **Subscribe** ליד `messages`.

### שלב 5 — בדיקה 🎉
שלח/י הודעת וואטסאפ למספר העסקי (מהמספר שאישרת בשלב 2) — הבוט אמור לענות תוך שניות!

---

## 🧪 בדיקה מקומית (לפני פריסה — אופציונלי)

אם רוצים לבדוק שהחיבור ל-Claude עובד עוד לפני העלייה לאוויר:

1. ודא/י ש-[Node.js](https://nodejs.org) גרסה 20+ מותקן.
2. בתיקיית הפרויקט:
   ```bash
   npm install
   ```
3. צור/צרי קובץ `.env` (העתק/י מ-`.env.example`) ומלא/י לפחות את `ANTHROPIC_API_KEY`.
4. הרץ/הריצי את בדיקת הבוט:
   ```bash
   npm run test:claude
   ```
   הבוט יענה על כמה שאלות לדוגמה — כך תדע/י שהמפתח והתשובות תקינים.
5. להרצת השרת המלא מקומית: `npm run dev` (יעלה על `http://localhost:3000`).

---

## ✏️ איך לעדכן את הבוט
- **לשנות מוצרים/מחירים/תשובות** → ערוך/ערכי את `src/business-info.js` ופרוס/פרסי מחדש (ב-Railway זה אוטומטי אחרי push לגיטהאב).
- **לשנות את הטון/האישיות** → ערוך/ערכי את `SYSTEM_PROMPT` בקובץ `src/claude.js`.
- **מודל חכם יותר/זול יותר** → שנה/י את `MODEL` בקובץ `src/claude.js` (מוסבר בהערה שם).

---

## ❓ פתרון תקלות
| בעיה | פתרון |
|------|-------|
| אימות ה-webhook נכשל | ודא/י ש-`VERIFY_TOKEN` ב-Railway זהה בדיוק לזה שהזנת ב-Meta, ושהכתובת מסתיימת ב-`/webhook`. |
| הבוט לא עונה | בדוק/בדקי את הלוגים ב-Railway. ודא/י שנרשמת ל-`messages` (שלב 4.4) ושהטוקן לא פג תוקף. |
| שגיאת Claude | ודא/י שמפתח ה-API תקין ושיש קרדיט בחשבון Anthropic. |
| `npm install` נכשל על גרסת חבילה | הרץ/הריצי `npm install @anthropic-ai/sdk@latest express` — זה יתקין את הגרסה הזמינה העדכנית. |
| "מספר לא מאושר" | בפיתוח אפשר לשלוח רק למספרים שהוספת ב-API Setup. לקהל הרחב צריך לאמת את מספר העסק ולעבור ל-Production. |
