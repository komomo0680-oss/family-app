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
  if (!list.length) return 0;
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
  const okCount = res.responses.filter((r) => r.success).length;
  console.log(`送信：${title} ${body.slice(0, 20)}（${okCount}/${tokens.length}台に成功）`);
  return okCount;
}

async function due(col) {
  const s = await col.where('at', '<=', nowL).where('at', '>=', cutL).get();
  return s.docs.filter((d) => !d.data().pushed);
}

// 1) （家族みんなへのリマインドは、送らない。リマインドは本人にだけ通知する）
// 2) 自分だけのリマインド
for (const u of userRefs) {
  const mine = devices.filter((x) => x.uid === u.id);
  if (!mine.length) continue;
  for (const d of await due(u.collection('rems'))) {
    const ok = await send(mine, '🐾 小西家', String(d.data().text || ''), 'rem-' + d.id);
    if (ok > 0) await d.ref.update({ pushed: true });
  }
}
// 3) チャット（書いた本人以外に通知）
const cs = await fam.collection('chat').where('ts', '>=', now - CHAT_MIN * 60e3).get();
for (const d of cs.docs) {
  const c = d.data();
  if (c.pushed) continue;
  const targets = devices.filter((x) => x.uid !== c.uid && x.chat);
  const ok = await send(targets, '💬 ' + (c.who || '家族'), String(c.text || '').slice(0, 80), 'chat-' + d.id);
  if (ok > 0 || !targets.length) await d.ref.update({ pushed: true });
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
const fcMemo = new Map();
async function forecast(pos) {
  const key = pos.latitude + ',' + pos.longitude;
  if (fcMemo.has(key)) return fcMemo.get(key);
  let r = null;
  try {
    const w = await (await fetch('https://api.open-meteo.com/v1/forecast?latitude=' + pos.latitude + '&longitude=' + pos.longitude + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FTokyo&forecast_days=7')).json();
    r = w.daily || null;
  } catch (e) { console.log('天気の取得に失敗：' + e.message); }
  fcMemo.set(key, r);
  return r;
}
let defPos;
async function getDefaultPos() {
  if (defPos !== undefined) return defPos;
  defPos = null;
  try {
    if (typeof cfg.lat === 'number' && typeof cfg.lon === 'number') defPos = { latitude: cfg.lat, longitude: cfg.lon };
    else {
      const names = [cfg.city, String(cfg.city).replace(/(都|道|府|県|市|区|町|村)$/, '')].filter((v, i, a) => v && a.indexOf(v) === i);
      for (const nm of names) {
        const g = await (await fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(nm) + '&count=1&language=ja&country_code=JP')).json();
        if (g.results && g.results[0]) { defPos = g.results[0]; break; }
      }
    }
  } catch (e) { console.log('地域の取得に失敗：' + e.message); }
  if (!defPos) console.log('天気の地域が見つかりません：' + cfg.city);
  return defPos;
}
function newsLines(events, todos, w, td, cityName, bring) {
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
    L.push('今日の' + cityName + 'は' + WC(w.weather_code[0]) + '　最高' + Math.round(w.temperature_2m_max[0]) + '°　最低' + Math.round(w.temperature_2m_min[0]) + '°　降水' + w.precipitation_probability_max[0] + '%');
    const r = w.weather_code.filter((c, i) => isRain(c, w.precipitation_probability_max[i])).length;
    if (r) L.push('今週は雨予報（' + r + '日）');
  }
  const wd = new Date(td + 'T00:00:00Z').getUTCDay();
  const items = (bring || []).filter((b) => (b.days || []).includes(wd)).map((b) => b.name + (b.who ? '（' + b.who + '）' : ''));
  if (w) {
    if (isRain(w.weather_code[0], w.precipitation_probability_max[0])) items.push('傘（雨予報）');
    if (w.temperature_2m_max[0] >= 28) items.push('水筒（暑い日）');
    if (w.temperature_2m_min[0] <= 8) items.push('上着（寒い日）');
  }
  if (items.length) L.push('🎒 今日の持ち物：' + items.join('、'));
  return L;
}
const todayStr = nowL.slice(0, 10);
const hourJ = new Date(now + TZ_HOURS * 3600e3).getUTCHours();
console.log(`朝のニュース：設定は${cfg.news !== false ? 'オン' : 'オフ'} / 送る時間は${cfg.newsHour}時台から3時間 / 今は${hourJ}時台`);
if (cfg.news === false) console.log('朝のニュース：family-config.json で news が false です');
else if (!(hourJ >= cfg.newsHour && hourJ < cfg.newsHour + 3)) console.log('朝のニュース：いまは送る時間帯ではありません');
if (cfg.news !== false && hourJ >= cfg.newsHour && hourJ < cfg.newsHour + 3) {
  const [sEv, sTd, sBr] = await Promise.all([fam.collection('events').get(), fam.collection('todos').get(), fam.collection('bring').get()]);
  const shared = { ev: sEv.docs.map((d) => d.data()), td: sTd.docs.map((d) => d.data()), br: sBr.docs.map((d) => d.data()) };
  for (const u of userRefs) {
    const mine = devices.filter((x) => x.uid === u.id && x.news !== false);
    if (!mine.length) { console.log('朝のニュース：通知を受け取る端末がありません（' + u.id.slice(0, 6) + '…）'); continue; }
    const flagId = todayStr + (cfg.newsTest ? '-' + cfg.newsTest : ''); // newsTest を入れると、同じ日にもう一度ためせる
    const flag = u.collection('newsSent').doc(flagId);
    if ((await flag.get()).exists) { console.log('朝のニュース：今日はもう送信済みです（' + u.id.slice(0, 6) + '…）'); continue; }
    const [pEv, pTd, pBr] = await Promise.all([u.collection('events').get(), u.collection('todos').get(), u.collection('bring').get()]);
    const sd = await u.collection('settings').doc('weather').get();
    const sv = sd.exists ? sd.data() : null;
    let pos, cityName;
    if (sv && typeof sv.lat === 'number') { pos = { latitude: sv.lat, longitude: sv.lon }; cityName = sv.city || '現在地'; }
    else { pos = await getDefaultPos(); cityName = cfg.city; }
    const weather = pos ? await forecast(pos) : null;
    const lines = newsLines(shared.ev.concat(pEv.docs.map((d) => d.data())), shared.td.concat(pTd.docs.map((d) => d.data())), weather, todayStr, cityName, shared.br.concat(pBr.docs.map((d) => d.data())));
    const [, mm, dd] = todayStr.split('-');
    const ok = await send(mine, '📰 家族ニュース ' + +mm + '/' + +dd, lines.map((l) => '・' + l).join('\n'), 'news-' + flagId);
    if (ok > 0) await flag.set({ ts: now }); // 届かなかったときは、次の実行でもう一度ためす
  }
}

// 5) Androidウィジェット用のニュース（コードを作った人だけ。1時間に1回＋初回）
async function weatherFor(u) {
  const sd = await u.collection('settings').doc('weather').get();
  const sv = sd.exists ? sd.data() : null;
  let pos, cityName;
  if (sv && typeof sv.lat === 'number') { pos = { latitude: sv.lat, longitude: sv.lon }; cityName = sv.city || '現在地'; }
  else { pos = await getDefaultPos(); cityName = cfg.city; }
  return { weather: pos ? await forecast(pos) : null, cityName };
}
if (cfg.widget !== false) {
  const minuteJ = new Date(now + TZ_HOURS * 3600e3).getUTCMinutes();
  let sh;
  for (const u of userRefs) {
    const wd = await u.collection('settings').doc('widget').get();
    const token = wd.exists ? wd.data().token : '';
    if (!/^[0-9a-f]{40}$/.test(String(token))) continue;
    const wdoc = db.collection('widgets').doc(token);
    if (minuteJ >= 5 && (await wdoc.get()).exists) continue;
    if (!sh) {
      const [a, b, c] = await Promise.all([fam.collection('events').get(), fam.collection('todos').get(), fam.collection('bring').get()]);
      sh = { ev: a.docs.map((d) => d.data()), td: b.docs.map((d) => d.data()), br: c.docs.map((d) => d.data()) };
    }
    const [pEv, pTd, pBr, pGo] = await Promise.all([u.collection('events').get(), u.collection('todos').get(), u.collection('bring').get(), u.collection('goals').get()]);
    const { weather, cityName } = await weatherFor(u);
    const todos = sh.td.concat(pTd.docs.map((d) => d.data()));
    const lines = [];
    pGo.docs.map((d) => d.data()).filter((g) => g.kind === 'long' && !g.d).slice(0, 3).forEach((g) => lines.push('🎯 ' + g.t));
    lines.push(...newsLines(sh.ev.concat(pEv.docs.map((d) => d.data())), todos, weather, todayStr, cityName, sh.br.concat(pBr.docs.map((d) => d.data()))).map((l) => '・' + l));
    todos.filter((x) => !x.d).slice(0, 5).forEach((x) => lines.push('✅ ' + x.t));
    await wdoc.set({ lines, updated: nowL.slice(5, 16).replace('T', ' '), ts: now });
    console.log('ウィジェット：更新（' + u.id.slice(0, 6) + '…）');
  }
}
console.log('完了');
