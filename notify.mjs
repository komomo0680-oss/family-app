// 小西家：時間になったリマインドと、新しいチャットを、登録済みのスマホに通知する
// GitHub Actions から5分おきに実行されます（日本時間で判定）
import admin from 'firebase-admin';
import fs from 'node:fs';

const TZ_HOURS = 9;        // 日本時間
const WINDOW_MIN = 120;    // 時間を過ぎてから何分までは通知するか
const CHAT_MIN = 30;       // 何分以内のチャットを通知するか

let cfg = { city: '東京', news: true, newsHour: 7 };
try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync('family-config.json', 'utf8')) }; } catch (e) { /* 設定ファイルがなければ初期値 */ }

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
    if (x.token) devices.push({ uid: u.id, ref: d.ref, token: x.token, chat: x.chat !== false, news: x.news !== false });
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

// 4) 朝の家族ニュース（1日1回、設定の時間になったら。共有の分＋その人だけの分をまとめる）
const fixMD = (y, md) => (md === '02-29' && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? y + '-02-28' : y + '-' + md);
function eff(e, td) {
  if (!e.date) return null;
  if (!e.yearly) return e.date;
  const y = +td.slice(0, 4);
  let c = fixMD(y, e.date.slice(5));
  if (c < td) c = fixMD(y + 1, e.date.slice(5));
  if (c < e.date) c = e.date;
  return c;
}
const dayDiff = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 864e5);
const WC = (c) => (c === 0 ? '快晴' : c <= 2 ? '晴れ' : c === 3 ? 'くもり' : c <= 48 ? '霧' : c <= 57 ? '霧雨' : c <= 67 ? '雨' : c <= 77 ? '雪' : c <= 82 ? 'にわか雨' : c <= 86 ? 'にわか雪' : '雷雨');
const isRain = (c, p) => (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95 || p >= 60;
async function getWeather() {
  try {
    const g = await (await fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(cfg.city) + '&count=1&language=ja&country_code=JP')).json();
    const r = g.results && g.results[0];
    if (!r) { console.log('天気の地域が見つかりません：' + cfg.city); return null; }
    const w = await (await fetch('https://api.open-meteo.com/v1/forecast?latitude=' + r.latitude + '&longitude=' + r.longitude + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FTokyo&forecast_days=7')).json();
    return w.daily;
  } catch (e) { console.log('天気の取得に失敗：' + e.message); return null; }
}
function newsLines(events, todos, w, td) {
  const L = [];
  const evs = events.map((e) => ({ e, d: eff(e, td) })).filter((o) => o.d);
  const today = evs.filter((o) => o.d === td).sort((a, b) => ((a.e.time || '') < (b.e.time || '') ? -1 : 1));
  if (today.length) L.push('今日の予定 ' + today.length + '件：' + today.slice(0, 3).map((o) => o.e.title + (o.e.time ? '（' + o.e.time + '）' : '')).join('、') + (today.length > 3 ? ' ほか' : ''));
  else L.push('今日の予定はありません');
  evs.filter((o) => { const k = dayDiff(o.d, td); return (o.e.special || o.e.countdown) && k > 0 && k <= (o.e.special ? 14 : 30); })
    .sort((a, b) => dayDiff(a.d, td) - dayDiff(b.d, td)).slice(0, 3)
    .forEach((o) => { const k = dayDiff(o.d, td); L.push(k === 1 ? '明日は' + o.e.title : o.e.title + 'まであと' + k + '日'); });
  const n = todos.filter((x) => !x.d).length;
  L.push(n ? 'TODO 未完了 ' + n + '件' : 'TODOはぜんぶ終わっています');
  if (w) {
    L.push('今日の' + cfg.city + 'は' + WC(w.weather_code[0]) + '　最高' + Math.round(w.temperature_2m_max[0]) + '°　最低' + Math.round(w.temperature_2m_min[0]) + '°　降水' + w.precipitation_probability_max[0] + '%');
    const r = w.weather_code.filter((c, i) => isRain(c, w.precipitation_probability_max[i])).length;
    if (r) L.push('今週は雨予報（' + r + '日）');
  }
  return L;
}
const todayStr = nowL.slice(0, 10);
const hourJ = new Date(now + TZ_HOURS * 3600e3).getUTCHours();
if (cfg.news !== false && hourJ >= cfg.newsHour && hourJ < cfg.newsHour + 3) {
  const [sEv, sTd] = await Promise.all([fam.collection('events').get(), fam.collection('todos').get()]);
  const shared = { ev: sEv.docs.map((d) => d.data()), td: sTd.docs.map((d) => d.data()) };
  let weather;
  for (const u of userRefs) {
    const mine = devices.filter((x) => x.uid === u.id && x.news !== false);
    if (!mine.length) continue;
    const flag = u.collection('newsSent').doc(todayStr);
    if ((await flag.get()).exists) continue;
    const [pEv, pTd] = await Promise.all([u.collection('events').get(), u.collection('todos').get()]);
    if (weather === undefined) weather = await getWeather();
    const lines = newsLines(shared.ev.concat(pEv.docs.map((d) => d.data())), shared.td.concat(pTd.docs.map((d) => d.data())), weather, todayStr);
    const [, mm, dd] = todayStr.split('-');
    await send(mine, '📰 家族ニュース ' + +mm + '/' + +dd, lines.map((l) => '・' + l).join('\n'), 'news-' + todayStr);
    await flag.set({ ts: now });
  }
}
console.log('完了');
