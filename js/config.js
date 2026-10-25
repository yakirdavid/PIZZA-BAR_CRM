// הגדרות חיבור למסד הנתונים. ראו הוראות ב-README.md.
// כל עוד השדות ריקים – המערכת עובדת ב"מצב מקומי": הנתונים נשמרים בדפדפן הנוכחי בלבד.
// ערכים אלה אינם סודיים (מפתח ציבורי); האבטחה נעשית ע״י הכניסה וחוקי הגישה במסד הנתונים.

// Supabase (מומלץ): Project Settings → API
export const supabaseConfig = {
  url: 'https://cbjxqpwvhdxnulilkzzx.supabase.co',
  anonKey: 'sb_publishable_FYCiIVwcBldpU13cjYqqGQ_6m6ILIFA',
};

// חלופה: Firebase (משמש רק אם Supabase לא הוגדר)
export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
};
