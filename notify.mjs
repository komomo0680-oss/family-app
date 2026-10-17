// 小西家：時間になったリマインドと、新しいチャットを、登録済みのスマホに通知する
// GitHub Actions から5分おきに実行されます（日本時間で判定）
import admin from 'firebase-admin';

const TZ_HOURS = 9;        // 日本時間
const WINDOW_MIN = 120;    // 時間を過ぎてから何分までは通知するか
const CHAT_MIN = 30;       // 何分以内のチャットを通知するか

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
if (!sa.project_id) { console.error('FIREBASE_SERVICE_ACCOUNT が設定されていません'); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(sa) });
const db = admin.firestore();
const fam = db.collection('families').doc('main');

const local = (ms) => new Date(ms + TZ_HOURS * 3600e3).toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
const now = Date.now();
const nowL = local(now);
const cutL = local(now - WINDOW_MIN * 60e3);
console.log(`日本時間 ${nowL} / 対象は ${cutL} 以降のリマインド`);

const userRefs = await db.collection('users').listDocuments();
const devices = [];
for (const u of userRefs) {
  const snap = await u.collection('devices').get();
  snap.forEach((d) => {
    const x = d.data();
    if (x.token) devices.push({ uid: u.id, ref: d.ref, token: x.token, chat: x.chat !== false });
  });
}
console.log(`登録された端末：${devices.length}台`);
if (!devices.length) process.exit(0);

async function send(list, title, body, tag) {
  if (!list.length) return;
  const tokens = [...new Set(list.map((d) => d.token))];
  const res = await admin.messaging().sendEachForMulticast({
    tokens,
    data: { title, body, tag, url: './family-app.html' },
    webpush: { headers: { Urgency: 'high', TTL: '3600' } },
  });
  const dead = new Set();
  res.responses.forEach((r, i) => {
    if (!r.success) {
      const c = r.error && r.error.code;
      console.log('送信失敗', c);
      if (c === 'messaging/registration-token-not-registered' || c === 'messaging/invalid-registration-token') dead.add(tokens[i]);
    }
  });
  for (const d of list) if (dead.has(d.token)) await d.ref.delete().catch(() => {});
  console.log(`送信：${title} ${body.slice(0, 20)}（${tokens.length}台）`);
}

async function due(col) {
  const s = await col.where('at', '<=', nowL).where('at', '>=', cutL).get();
  return s.docs.filter((d) => !d.data().pushed);
}

// 1) 家族みんなのリマインド（共有の予定から作られたもの）
for (const d of await due(fam.collection('rems'))) {
  await send(devices, '🐾 小西家', String(d.data().text || ''), 'rem-' + d.id);
  await d.ref.update({ pushed: true });
}
// 2) 自分だけのリマインド
for (const u of userRefs) {
  const mine = devices.filter((x) => x.uid === u.id);
  if (!mine.length) continue;
  for (const d of await due(u.collection('rems'))) {
    await send(mine, '🐾 小西家', String(d.data().text || ''), 'rem-' + d.id);
    await d.ref.update({ pushed: true });
  }
}
// 3) チャット（書いた本人以外に通知）
const cs = await fam.collection('chat').where('ts', '>=', now - CHAT_MIN * 60e3).get();
for (const d of cs.docs) {
  const c = d.data();
  if (c.pushed) continue;
  const targets = devices.filter((x) => x.uid !== c.uid && x.chat);
  await send(targets, '💬 ' + (c.who || '家族'), String(c.text || '').slice(0, 80), 'chat-' + d.id);
  await d.ref.update({ pushed: true });
}
console.log('完了');
