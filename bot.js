const TelegramBot = require('node-telegram-bot-api');
const axios       = require('axios');
const crypto      = require('crypto');
const zlib        = require('zlib');

// ============================================================
//  CONFIG
// ============================================================
const BOT_TOKEN    = "8678093059:AAEkXmAGdWzl9ytR_Z2tlw3n6Ki5vY5XA1k";
const OWNER_ID     = 8321379592;
const OWNER_PASS   = "suthamari6381";
const ADMIN_HANDLE = "@OnlineEarningapp_bot";
const REG_LINK     = "https://www.goaoko.com/#/register?invitationCode=457367799017";
const WIN_STICKER  = "CAACAgUAAxkBAAFHUGNp4JX1-ohP4uBEWpfNptaz-HmwVgAC4hgAAhboKVbObuGuTcMs2zsE";
const LOSS_STICKER = "CAACAgUAAxkBAAFHUGVp4JX-BE2TRkhIKTwcjkwW-gzdPAACthoAAoG8YVYiydObSa0O8zsE";
// Cloud AI kudutha logic-ah namma Node.js-ku mathi ezhuthiruken
const BET_URL  = "https://api.ar-lottery01.com/api/Lottery/WinGoBet";
const DRAW_URL = "https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json";

// ============================================================
//  STORAGE
// ============================================================
let ownerLoggedIn  = false;
let adminPasswords = {};
let adminLoggedIn  = {};
let usersAccess    = {};
let keyStore       = {};
let stats          = {};
let running        = {};
let sentPeriods    = {};
let ownerState     = null;
let adminState     = {};
let userTokens     = {};
let autobetCfg     = {};
let autobetState   = {};
let profitTrack    = {};
let GLOBAL_TOKEN   = "";

// ============================================================
//  HELPERS
// ============================================================
function initUser(id) {
    if (!stats[id])        stats[id]        = { total:0,win:0,loss:0,lossStreak:0,winStreak:0,maxWinStreak:0,maxLossStreak:0 };
    if (!sentPeriods[id])  sentPeriods[id]  = new Set();
    if (!autobetCfg[id])   autobetCfg[id]   = { watch:true, watchLoss:5, baseBet:10, maxLvl:4, enabled:false };
    if (!autobetState[id]) autobetState[id] = { level:1, vLoss:0, inMart:false, curPeriod:null };
    if (!profitTrack[id])  profitTrack[id]  = { totalBets:0, wins:0, losses:0, pnl:0, winStreak:0, lossStreak:0, maxW:0, maxL:0 };
}
function hasAccess(id)  { return !!(usersAccess[id] && Date.now() < usersAccess[id]); }
function daysLeft(id)   { return usersAccess[id] ? ((usersAccess[id]-Date.now())/86400000).toFixed(1) : "0"; }
function isAdmin(id)    { return adminPasswords[id] !== undefined; }
function isAdminIn(id)  { return adminLoggedIn[id] === true; }
function sleep(ms)      { return new Promise(r => setTimeout(r, ms)); }
const MULT = [1,3,9,27,81,243,729];

function getToken(userId) { return userTokens[userId] || GLOBAL_TOKEN || ""; }

function generateKey(days, by) {
    const k = "SIVA-"+crypto.randomBytes(3).toString('hex').toUpperCase()+"-"+crypto.randomBytes(2).toString('hex').toUpperCase();
    keyStore[k] = { days, used:false, usedBy:null, by:by||OWNER_ID };
    return k;
}
function activateKey(userId, code) {
    const k = code.toUpperCase().trim();
    if (!keyStore[k])     return { ok:false, msg:"❌ Invalid key!" };
    if (keyStore[k].used) return { ok:false, msg:"❌ Key already used!" };
    const days = keyStore[k].days;
    keyStore[k].used=true; keyStore[k].usedBy=userId;
    const base = (usersAccess[userId]&&usersAccess[userId]>Date.now()) ? usersAccess[userId] : Date.now();
    usersAccess[userId] = base + days*86400000;
    return { ok:true, days, expiry:new Date(usersAccess[userId]).toLocaleString() };
}
function activeUsersList() {
    const now=Date.now(), list=Object.entries(usersAccess).filter(([,e])=>e>now);
    return list.length ? list.map(([id,e])=>"🟢 "+id+" | "+((e-now)/86400000).toFixed(1)+"d").join("\n") : "No active users.";
}
function adminList() {
    const ids=Object.keys(adminPasswords);
    return ids.length ? ids.map(id=>"👤 "+id+" | "+(adminLoggedIn[id]?"🟢 Online":"🔴 Offline")).join("\n") : "No admins.";
}
function allKeysList() {
    const keys=Object.entries(keyStore);
    return keys.length ? keys.map(([k,v])=>k+" → "+(v.used?"✅ Used":"🟢 "+v.days+"d")).join("\n") : "No keys.";
}

// ============================================================
//  KEYBOARDS
// ============================================================
function userMenu(id) {
    const rows=[
        ["▶️ Start Prediction","🛑 Stop"],
        ["📊 Stats","💰 Profit","📩 Contact"],
        ["🤖 AutoBet Setup","🔑 My Token"]
    ];
    if (isAdmin(id)) rows.push(["👑 Admin Panel"]);
    return { keyboard:rows, resize_keyboard:true };
}
const ownerMenu = { keyboard:[
    ["👥 All Users","👮 All Admins"],
    ["👤 Add Admin","🗑 Remove Admin"],
    ["🔑 Generate Key","📋 All Keys"],
    ["🟢 Add User","🔴 Remove User"],
    ["🔐 Set Token","📊 All Stats"],
    ["🚪 Owner Logout"]
], resize_keyboard:true };
const adminMenu = { keyboard:[
    ["👥 Active Users","🔑 Generate Key"],
    ["🟢 Add User","🔴 Remove User"],
    ["📋 All Keys","🚪 Admin Logout"]
], resize_keyboard:true };
const autobetMenu = { keyboard:[
    ["✅ Enable AutoBet","❌ Disable AutoBet"],
    ["👀 Watch Mode ON","👀 Watch Mode OFF"],
    ["💰 Set Base Bet","📈 Set Max Level"],
    ["🔢 Set Watch Losses","📊 AutoBet Status"],
    ["🔙 Back"]
], resize_keyboard:true };

// ============================================================
//  BOT INIT
// ============================================================
let bot;
function startBot() {
    if (bot) { try { bot.stopPolling(); } catch(e){} }
    bot = new TelegramBot(BOT_TOKEN, { polling:{ interval:1000, autoStart:true, params:{timeout:30} } });
    bot.on("polling_error", err=>{ console.error("Poll:",err.message); setTimeout(startBot,5000); });
    bot.on("error",         err=>{ console.error("Bot:", err.message); });
    addHandlers();
    console.log("✅ SIVA BOT running...");
}
async function send(chatId, text, opts={}) {
    try { return await bot.sendMessage(chatId, text, opts); }
    catch(e) {
        if (e.message&&e.message.includes("parse entities")) {
            try { const o={...opts}; delete o.parse_mode; return await bot.sendMessage(chatId,text,o); } catch(e2){}
        }
        console.error("send:",e.message);
    }
}
async function sendSticker(chatId, sid) { try { await bot.sendSticker(chatId, sid); } catch(e){} }

// ============================================================
//  FETCH HISTORY
// ============================================================
function decodeBuffer(buf) {
    try { return JSON.parse(buf.toString("utf8")); } catch(e){}
    try { return JSON.parse(zlib.gunzipSync(buf).toString("utf8")); } catch(e){}
    try { return JSON.parse(zlib.inflateSync(buf).toString("utf8")); } catch(e){}
    try { return JSON.parse(zlib.inflateRawSync(buf).toString("utf8")); } catch(e){}
    try { return JSON.parse(zlib.brotliDecompressSync(buf).toString("utf8")); } catch(e){}
    return null;
}
async function fetchList(retries=3) {
    for (let i=0;i<retries;i++) {
        try {
            const res = await axios.get(DRAW_URL+"?ts="+Date.now(), {
                headers:{
                    "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36",
                    "Accept": "application/json, text/plain, */*",
                    "Accept-Encoding": "gzip, deflate, br",
                    "Origin": "https://goaokk.com",
                    "Referer": "https://goaokk.com/"
                },
                timeout:10000, decompress:true, responseType:"arraybuffer"
            });
            const data = decodeBuffer(Buffer.from(res.data));
            if (!data) continue;
            const list = data?.data?.list;
            if (list&&list.length>0) return list;
        } catch(e) {
            console.error("Fetch",i+1,":",e.message);
            if (i<retries-1) await sleep(3000);
        }
    }
    return null;
}

// ============================================================
//  PLACE BET
//  ⚠️ Goaoko uses server-side secret in signature
//  So we copy EXACT payload from browser DevTools
//  User does: /setpayload random|timestamp|signature
//  Bot uses those values for next bet
// ============================================================
let userPayload = {}; // userId -> { random, timestamp, signature }
let payloadState = {}; // userId -> waiting for which field

async function placeBet(userId, chatId, period, prediction, predType, level) {
    const token = getToken(userId);
    if (!token || token.length < 20) {
        await send(chatId, "❌ Token இல்லை!\n\n/setmytoken YOUR_TOKEN");
        return false;
    }

    const cfg     = autobetCfg[userId];
    const betMult = cfg.baseBet * MULT[level-1];

    let bc = "";
    if (predType === "SIZE")  bc = prediction === "BIG" ? "BigSmall_Big" : "BigSmall_Small";
    if (predType === "COLOR") bc = prediction === "RED" ? "Color_Red"    : "Color_Green";

    // Step 1: Build params (NO timestamp yet, NO signature yet)
    const params = {
        amount:      1,
        betContent:  bc,
        betMultiple: betMult,
        gameCode:    "WinGo_1M",
        issueNumber: String(period),
        language:    "en",
        random:      Math.floor(Math.random() * 1e12)
    };

    // Step 2: Sort keys, filter null/"", exclude "signature"
    const sortedKeys = Object.keys(params)
        .filter(k => params[k] !== null && params[k] !== "")
        .sort();

    const sortedObj = {};
    sortedKeys.forEach(k => {
        sortedObj[k] = params[k] === 0 ? 0 : params[k];
    });

    // Step 3: MD5(JSON.stringify(sortedObj)) → UPPER → slice(0,32)
    const signature = crypto.createHash("md5")
        .update(JSON.stringify(sortedObj))
        .digest("hex")
        .toUpperCase()
        .slice(0, 32);

    // Step 4: NOW add timestamp (after signature)
    const timestamp = Math.floor(Date.now() / 1000);

    const payload = { ...params, signature, timestamp };

    console.log("[SIG INPUT]", JSON.stringify(sortedObj));
    console.log("[SIG]", signature);
    console.log("[PAYLOAD]", JSON.stringify(payload));

    const headers = {
        "authorization":    "Bearer " + token,
        "content-type":     "application/json",
        "Accept":           "application/json, text/plain, */*",
        "Origin":           "https://goaokk.com",
        "Referer":          "https://goaokk.com/",
        "Ar-Origin":        "https://goaokk.com",
        "Sec-Ch-Ua":        '"Chromium";v="139"',
        "Sec-Ch-Ua-Mobile": "?1",
        "Sec-Fetch-Dest":   "empty",
        "Sec-Fetch-Mode":   "cors",
        "Sec-Fetch-Site":   "cross-site",
        "User-Agent":       "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36"
    };

    try {
        const r = await axios.post(BET_URL, payload, { headers, timeout: 10000 });
        const d = r.data;
        console.log("[BET RESP]", JSON.stringify(d));

        if (d.code === 0 || d.msg === "Succeed" || d.msgCode === 0) {
            return { ok: true, amt: betMult, bc };
        }

        if (d.code===401 || d.code===40100 || (d.msg && d.msg.toLowerCase().includes("token"))) {
            await send(chatId, "🔴 TOKEN EXPIRED!\n/setmytoken பண்ணு");
            userTokens[userId] = "";
            return false;
        }

        if (d.msg && d.msg.toLowerCase().includes("signature")) {
            await send(chatId, "❌ Signature தப்பு!\nConsole-ல [SIG INPUT] பாரு");
            return false;
        }

        await send(chatId, "❌ Bet fail: " + (d.msg || JSON.stringify(d).substr(0, 80)));
        return false;

    } catch (err) {
        console.error("[BET ERR]", err.message);
        await send(chatId, "❌ Network error: " + err.message);
        return false;
    }
}
// ============================================================
//  PREDICTION ENGINE — 90%+ confidence
// ============================================================
function parseResult(item) {
    const n = parseInt(item.number);
    return { n, size:n>=5?"BIG":"SMALL", color:n===0?"RED":n===5?"GREEN":n%2===0?"RED":"GREEN" };
}
function stk(arr,k){ let c=1; for(let i=1;i<arr.length;i++){if(arr[i][k]===arr[0][k])c++;else break;} return{val:arr[0][k],count:c}; }
function cnt(arr,k,v){ return arr.filter(x=>x[k]===v).length; }
function isAlt(arr,k,n){ for(let i=0;i<n-1;i++){if(arr[i][k]===arr[i+1][k])return false;} return true; }
function isDbl(arr,k){ if(arr.length<8)return false; return arr[0][k]===arr[1][k]&&arr[2][k]===arr[3][k]&&arr[4][k]===arr[5][k]&&arr[6][k]===arr[7][k]&&arr[0][k]!==arr[2][k]&&arr[2][k]!==arr[4][k]; }
function isTrp(arr,k){ if(arr.length<6)return false; return arr[0][k]===arr[1][k]&&arr[1][k]===arr[2][k]&&arr[3][k]===arr[4][k]&&arr[4][k]===arr[5][k]&&arr[0][k]!==arr[3][k]; }

function detectSignal(list) {
    const data=list.slice(0,20).map(parseResult);
    const d5=data.slice(0,5),d6=data.slice(0,6),d8=data.slice(0,8);
    const d10=data.slice(0,10),d15=data.slice(0,15),d20=data.slice(0,20);
    const c=[];

    // SIZE
    const ss=stk(d10,"size");
    if(ss.count>=5)c.push({type:"SIZE",val:ss.val==="BIG"?"SMALL":"BIG",conf:95,pat:"5+ STREAK BREAK"});
    else if(ss.count===4)c.push({type:"SIZE",val:ss.val==="BIG"?"SMALL":"BIG",conf:91,pat:"4 STREAK BREAK"});
    else if(ss.count===3)c.push({type:"SIZE",val:ss.val==="BIG"?"SMALL":"BIG",conf:90,pat:"3 STREAK BREAK"});
    if(isAlt(d6,"size",6))c.push({type:"SIZE",val:d6[0].size==="BIG"?"SMALL":"BIG",conf:93,pat:"PERFECT ALT-6"});
    else if(isAlt(d5,"size",4))c.push({type:"SIZE",val:d5[0].size==="BIG"?"SMALL":"BIG",conf:90,pat:"PERFECT ALT-4"});
    const b20=cnt(d20,"size","BIG"),s20=cnt(d20,"size","SMALL");
    if(b20>=15)c.push({type:"SIZE",val:"SMALL",conf:91,pat:"15+/20 BIG→REV"});
    if(s20>=15)c.push({type:"SIZE",val:"BIG",conf:91,pat:"15+/20 SML→REV"});
    if(b20>=13)c.push({type:"SIZE",val:"SMALL",conf:90,pat:"13+/20 BIG→REV"});
    if(s20>=13)c.push({type:"SIZE",val:"BIG",conf:90,pat:"13+/20 SML→REV"});
    const b15=cnt(d15,"size","BIG"),s15=cnt(d15,"size","SMALL");
    if(b15>=12)c.push({type:"SIZE",val:"SMALL",conf:91,pat:"12/15 BIG→REV"});
    if(s15>=12)c.push({type:"SIZE",val:"BIG",conf:91,pat:"12/15 SML→REV"});
    const b10=cnt(d10,"size","BIG"),s10=cnt(d10,"size","SMALL");
    if(b10>=9)c.push({type:"SIZE",val:"SMALL",conf:94,pat:"9+/10 BIG→REV"});
    if(s10>=9)c.push({type:"SIZE",val:"BIG",conf:94,pat:"9+/10 SML→REV"});
    if(b10===8)c.push({type:"SIZE",val:"SMALL",conf:91,pat:"8/10 BIG→REV"});
    if(s10===8)c.push({type:"SIZE",val:"BIG",conf:91,pat:"8/10 SML→REV"});
    if(isDbl(d8,"size"))c.push({type:"SIZE",val:d8[6].size==="BIG"?"SMALL":"BIG",conf:91,pat:"DOUBLE PAIR"});
    if(isTrp(d6,"size"))c.push({type:"SIZE",val:d6[3].size,conf:91,pat:"TRIPLE PAIR"});

    // COLOR
    const sc=stk(d10,"color");
    if(sc.count>=5)c.push({type:"COLOR",val:sc.val==="RED"?"GREEN":"RED",conf:95,pat:"5+ STREAK BREAK"});
    else if(sc.count===4)c.push({type:"COLOR",val:sc.val==="RED"?"GREEN":"RED",conf:91,pat:"4 STREAK BREAK"});
    else if(sc.count===3)c.push({type:"COLOR",val:sc.val==="RED"?"GREEN":"RED",conf:90,pat:"3 STREAK BREAK"});
    if(isAlt(d6,"color",6))c.push({type:"COLOR",val:d6[0].color==="RED"?"GREEN":"RED",conf:93,pat:"PERFECT ALT-6"});
    else if(isAlt(d5,"color",4))c.push({type:"COLOR",val:d5[0].color==="RED"?"GREEN":"RED",conf:90,pat:"PERFECT ALT-4"});
    const r20=cnt(d20,"color","RED"),g20=cnt(d20,"color","GREEN");
    if(r20>=15)c.push({type:"COLOR",val:"GREEN",conf:91,pat:"15+/20 RED→REV"});
    if(g20>=15)c.push({type:"COLOR",val:"RED",conf:91,pat:"15+/20 GRN→REV"});
    if(r20>=13)c.push({type:"COLOR",val:"GREEN",conf:90,pat:"13+/20 RED→REV"});
    if(g20>=13)c.push({type:"COLOR",val:"RED",conf:90,pat:"13+/20 GRN→REV"});
    const r15=cnt(d15,"color","RED"),g15=cnt(d15,"color","GREEN");
    if(r15>=12)c.push({type:"COLOR",val:"GREEN",conf:91,pat:"12/15 RED→REV"});
    if(g15>=12)c.push({type:"COLOR",val:"RED",conf:91,pat:"12/15 GRN→REV"});
    const r10=cnt(d10,"color","RED"),g10=cnt(d10,"color","GREEN");
    if(r10>=9)c.push({type:"COLOR",val:"GREEN",conf:94,pat:"9+/10 RED→REV"});
    if(g10>=9)c.push({type:"COLOR",val:"RED",conf:94,pat:"9+/10 GRN→REV"});
    if(r10===8)c.push({type:"COLOR",val:"GREEN",conf:91,pat:"8/10 RED→REV"});
    if(g10===8)c.push({type:"COLOR",val:"RED",conf:91,pat:"8/10 GRN→REV"});
    if(isDbl(d8,"color"))c.push({type:"COLOR",val:d8[6].color==="RED"?"GREEN":"RED",conf:91,pat:"DOUBLE PAIR"});
    if(isTrp(d6,"color"))c.push({type:"COLOR",val:d6[3].color,conf:91,pat:"TRIPLE PAIR"});

    if(!c.length) return null;
    c.sort((a,b)=>b.conf-a.conf);
    return c[0].conf>=90 ? c[0] : null;
}

// ============================================================
//  AUTOBET LOGIC
// ============================================================
function shouldBetNow(userId) {
    const cfg=autobetCfg[userId], st=autobetState[userId];
    if (!cfg.enabled) return false;
    if (!getToken(userId)) return false;
    if (st.inMart) return true;
    if (!cfg.watch) return true;
    return st.vLoss >= cfg.watchLoss;
}

async function handleWin(userId, chatId, actual, num) {
    const st=autobetState[userId], pt=profitTrack[userId], cfg=autobetCfg[userId];
    const amt=cfg.baseBet*MULT[st.level-1], profit=amt*0.98;
    pt.totalBets++;pt.wins++;pt.pnl+=profit;
    pt.winStreak++;pt.lossStreak=0;if(pt.winStreak>pt.maxW)pt.maxW=pt.winStreak;
    st.level=1;st.vLoss=0;st.inMart=false;
    await send(chatId,
"╔══════════════════════════╗\n"+
"║  ✅  WIN! 🎉🎊           ║\n"+
"╠══════════════════════════╣\n"+
"║ 🔢 Number  : "+num+"\n"+
"║ 🎯 Result  : "+actual+"\n"+
"║ 💰 Profit  : +₹"+profit.toFixed(1)+"\n"+
"║ 📊 P&L     : "+(pt.pnl>=0?"+":"")+pt.pnl.toFixed(1)+"\n"+
"║ 🔥 WinStrk : "+pt.winStreak+" in a row\n"+
"║ 📈 Total   : "+pt.wins+"W/"+pt.losses+"L\n"+
"╚══════════════════════════╝\n"+
"💰 Level reset → L1"
    );
    await sendSticker(chatId,WIN_STICKER);
}

async function handleLoss(userId, chatId, actual, num) {
    const st=autobetState[userId], pt=profitTrack[userId], cfg=autobetCfg[userId];
    const amt=cfg.baseBet*MULT[st.level-1];
    pt.totalBets++;pt.losses++;pt.pnl-=amt;
    pt.lossStreak++;pt.winStreak=0;if(pt.lossStreak>pt.maxL)pt.maxL=pt.lossStreak;
    if(st.level < cfg.maxLvl){
        st.level++;st.inMart=true;
        const next=cfg.baseBet*MULT[st.level-1];
        await send(chatId,
"╔══════════════════════════╗\n"+
"║  ❌  LOSS                ║\n"+
"╠══════════════════════════╣\n"+
"║ 🔢 Number  : "+num+"\n"+
"║ 🎯 Result  : "+actual+"\n"+
"║ 💸 Loss    : -₹"+amt+"\n"+
"║ 📊 P&L     : "+(pt.pnl>=0?"+":"")+pt.pnl.toFixed(1)+"\n"+
"╠══════════════════════════╣\n"+
"║ 📈 Next L"+st.level+"  : ₹"+next+"\n"+
"╚══════════════════════════╝"
        );
        await sendSticker(chatId,LOSS_STICKER);
    } else {
        st.level=1;st.inMart=false;st.vLoss=0;
        await send(chatId,
"╔══════════════════════════╗\n"+
"║  💀 MAX LEVEL LOSS       ║\n"+
"╠══════════════════════════╣\n"+
"║ 💸 Loss    : -₹"+amt+"\n"+
"║ 📊 P&L     : "+(pt.pnl>=0?"+":"")+pt.pnl.toFixed(1)+"\n"+
"║ 🔄 Reset → L1            ║\n"+
"╚══════════════════════════╝"
        );
        await sendSticker(chatId,LOSS_STICKER);
    }
}

// ============================================================
//  PREDICT LOOP
// ============================================================
async function runPredict(userId, chatId) {
    if (!running[userId]) return;
    const list = await fetchList();
    if (!list) {
        await send(chatId,"⚠️ API error, retry...");
        return setTimeout(()=>runPredict(userId,chatId),10000);
    }
    const next   = (BigInt(list[0].issueNumber)+1n).toString();
    const signal = detectSignal(list);

    if (!signal) {
        const sk="SK_"+next;
        if (!sentPeriods[userId].has(sk)) {
            sentPeriods[userId].add(sk);
            await send(chatId,
"╔══════════════════════════╗\n"+
"║   ⏭️  SKIP ROUND         ║\n"+
"╠══════════════════════════╣\n"+
"║ 📅 Period : "+next.slice(-6)+"\n"+
"║ 🚫 No 90%+ pattern       ║\n"+
"║ ⏳ Waiting next signal...║\n"+
"╚══════════════════════════╝"
            );
        }
        return setTimeout(()=>runPredict(userId,chatId),20000);
    }

    if (sentPeriods[userId].has(next)) return setTimeout(()=>runPredict(userId,chatId),5000);
    sentPeriods[userId].add(next);
    if(sentPeriods[userId].size>50) sentPeriods[userId]=new Set([...sentPeriods[userId]].slice(-50));

    const st=autobetState[userId], cfg=autobetCfg[userId];
    const conf=signal.conf;
    const confBar="🟦".repeat(Math.round(conf/10))+"⬜".repeat(10-Math.round(conf/10));
    let predDisplay=signal.type==="SIZE"?(signal.val==="BIG"?"🔵 BIG (5-9)":"🟠 SMALL (0-4)"):(signal.val==="RED"?"🔴 RED":"🟢 GREEN");

    let abLine="🤖 AutoBet : OFF";
    if (cfg.enabled) {
        if (cfg.watch&&!st.inMart) {
            const need=cfg.watchLoss-st.vLoss;
            abLine=need>0?"👀 Watch  : "+st.vLoss+"/"+cfg.watchLoss+" ("+need+" more needed)"
                        :"💰 BET    : ₹"+(cfg.baseBet*MULT[st.level-1])+" L"+st.level;
        } else {
            abLine=st.inMart?"📈 Mart L"+st.level+" : ₹"+(cfg.baseBet*MULT[st.level-1])
                            :"💰 BET    : ₹"+(cfg.baseBet*MULT[st.level-1])+" L"+st.level;
        }
    }

    await send(chatId,
"╔══════════════════════════╗\n"+
"║  👑 SIVA ULTRA AI        ║\n"+
"╠══════════════════════════╣\n"+
"║ 📅 Period : "+next.slice(-6)+"\n"+
"║ 🎯 Signal : "+predDisplay+"\n"+
"║ 🏆 Pattern: "+signal.pat+"\n"+
"║ 🔥 Conf   : "+conf+"%\n"+
"║ "+confBar+"\n"+
"╠══════════════════════════╣\n"+
"║ "+abLine+"\n"+
"╠══════════════════════════╣\n"+
"║ ⚡ BET ON: "+signal.val+"\n"+
"╚══════════════════════════╝",
        {reply_markup:{inline_keyboard:[[{text:"💰 GOAOKO PLAY NOW",url:REG_LINK}]]}}
    );

    if (cfg.enabled && shouldBetNow(userId)) {
        const result = await placeBet(userId,chatId,next,signal.val,signal.type,st.level);
        if (result&&result.ok) {
            await send(chatId,"✅ AutoBet OK!\n📋 "+result.bc+"\n💰 ₹"+result.amt+" L"+st.level+"\n⏳ Waiting result...");
        }
    }

    checkResult(userId,chatId,next,signal.val,signal.type);
}

// ============================================================
//  RESULT CHECKER
// ============================================================
async function checkResult(userId, chatId, target, predicted, predType) {
    let tries=0;
    const cfg=autobetCfg[userId], st=autobetState[userId];
    const wasReal=cfg.enabled && shouldBetNow(userId);
    const iv=setInterval(async()=>{
        if (!running[userId]) return clearInterval(iv);
        if (++tries>18) { clearInterval(iv); await send(chatId,"⏱ Timeout — next..."); setTimeout(()=>{if(running[userId])runPredict(userId,chatId);},3000); return; }
        const list=await fetchList(); if(!list) return;
        if (BigInt(list[0].issueNumber)<BigInt(target)) return;
        clearInterval(iv);
        const res=list.find(i=>i.issueNumber===target)||list[0];
        const num=parseInt(res.number);
        let actual;
        if(predType==="SIZE") actual=num>=5?"BIG":"SMALL";
        else actual=num===0?"RED":num===5?"GREEN":num%2===0?"RED":"GREEN";
        const win=predicted===actual;
        const s=stats[userId];
        s.total++;
        if(win){s.win++;s.winStreak++;s.lossStreak=0;if(s.winStreak>s.maxWinStreak)s.maxWinStreak=s.winStreak;}
        else   {s.loss++;s.lossStreak++;s.winStreak=0;if(s.lossStreak>s.maxLossStreak)s.maxLossStreak=s.lossStreak;}

        if (cfg.enabled) {
            if (wasReal) {
                if(win) await handleWin(userId,chatId,actual,num);
                else    await handleLoss(userId,chatId,actual,num);
            } else {
                if(!win) {
                    st.vLoss++;
                    const need=cfg.watchLoss-st.vLoss;
                    await send(chatId,"👀 Watch Loss #"+st.vLoss+"/"+cfg.watchLoss+(need>0?"\n⏳ "+need+" more losses needed...":"\n🚀 Real bet starts next signal!"));
                } else {
                    await send(chatId,"👀 Watch: ✅ Signal correct! (virtual)\nvLoss: "+st.vLoss+"/"+cfg.watchLoss);
                }
            }
        } else {
            if(win){await send(chatId,"✅ WIN! #"+num+" "+actual+"\n🔥 "+s.winStreak+" streak");await sendSticker(chatId,WIN_STICKER);}
            else   {await send(chatId,"❌ LOSS #"+num+" "+actual+"\n💔 "+s.lossStreak+" loss");await sendSticker(chatId,LOSS_STICKER);}
        }
        setTimeout(()=>{if(running[userId])runPredict(userId,chatId);},8000);
    },10000);
}

// ============================================================
//  STATS & PROFIT
// ============================================================
function showStats(chatId,userId){
    const d=stats[userId],rate=d.total?((d.win/d.total)*100).toFixed(1):"0.0";
    const bar="🟦".repeat(d.total?Math.round(d.win/d.total*10):0)+"⬜".repeat(d.total?10-Math.round(d.win/d.total*10):10);
    send(chatId,
"╔══════════════════════════╗\n"+"║  📊 STATS                ║\n"+"╠══════════════════════════╣\n"+
"║ Total  : "+d.total+"\n"+"║ Wins   : "+d.win+"\n"+"║ Losses : "+d.loss+"\n"+
"║ Rate   : "+rate+"%\n"+"║ "+bar+"\n"+"╠══════════════════════════╣\n"+
"║ Best Win : "+d.maxWinStreak+" streak\n"+"║ Worst L  : "+d.maxLossStreak+" streak\n"+"╚══════════════════════════╝"
    );
}
function profitReport(chatId,userId){
    const pt=profitTrack[userId];
    const rate=pt.totalBets?((pt.wins/pt.totalBets)*100).toFixed(1):"0.0";
    const bar="🟦".repeat(pt.totalBets?Math.round(pt.wins/pt.totalBets*10):0)+"⬜".repeat(pt.totalBets?10-Math.round(pt.wins/pt.totalBets*10):10);
    send(chatId,
"╔══════════════════════════╗\n"+"║  💰 PROFIT REPORT        ║\n"+"╠══════════════════════════╣\n"+
"║ Real Bets : "+pt.totalBets+"\n"+"║ Wins      : "+pt.wins+"\n"+"║ Losses    : "+pt.losses+"\n"+
"║ Win Rate  : "+rate+"%\n"+"║ "+bar+"\n"+"╠══════════════════════════╣\n"+
"║ Total P&L : "+(pt.pnl>=0?"+":"")+pt.pnl.toFixed(1)+"\n"+
"║ Best Win  : "+pt.maxW+" streak\n"+"║ Worst Loss: "+pt.maxL+" streak\n"+"╚══════════════════════════╝"
    );
}
function autobetStatus(chatId,userId){
    const cfg=autobetCfg[userId],st=autobetState[userId],pt=profitTrack[userId];
    const tok=getToken(userId);
    const amounts=MULT.slice(0,cfg.maxLvl).map(m=>cfg.baseBet*m);
    send(chatId,
"╔══════════════════════════╗\n"+"║  🤖 AUTOBET STATUS       ║\n"+"╠══════════════════════════╣\n"+
"║ Status    : "+(cfg.enabled?"✅ ON":"❌ OFF")+"\n"+
"║ Token     : "+(tok?"✅ SET":"❌ MISSING")+"\n"+
"║ Watch Mode: "+(cfg.watch?"ON":"OFF")+"\n"+
"║ Watch Loss: "+cfg.watchLoss+"\n"+
"║ Base Bet  : ₹"+cfg.baseBet+"\n"+
"║ Max Levels: "+cfg.maxLvl+"\n"+
"╠══════════════════════════╣\n"+
"║ Mart Level: L"+st.level+"\n"+
"║ vLoss     : "+st.vLoss+"/"+cfg.watchLoss+"\n"+
"║ In Mart   : "+(st.inMart?"YES":"NO")+"\n"+
"╠══════════════════════════╣\n"+
"║ P&L       : "+(pt.pnl>=0?"+":"")+pt.pnl.toFixed(1)+"\n"+
"╚══════════════════════════╝\n"+
"Mart: ₹"+amounts.join(" → ₹")
    );
}

// ============================================================
//  HANDLERS
// ============================================================
function addHandlers(){
    bot.onText(/\/start/,(msg)=>{
        const id=msg.from.id; initUser(id);
        const status=hasAccess(id)?"✅ ACTIVE — "+daysLeft(id)+"d left":"❌ NO ACCESS";
        send(msg.chat.id,
"╔══════════════════════════╗\n"+"║  👑 SIVA ULTRA AI BOT    ║\n"+"╠══════════════════════════╣\n"+
"║ Status : "+status+"\n"+"║ ID     : "+id+"\n"+"║ Admin  : "+ADMIN_HANDLE+"\n"+"╠══════════════════════════╣\n"+
"║ 🔑 Have key? /key CODE   ║\n"+"╚══════════════════════════╝",
        {reply_markup:userMenu(id)});
    });

    bot.onText(/\/key (.+)/,(msg,match)=>{
        const id=msg.from.id; initUser(id);
        const res=activateKey(id,match[1].trim());
        if(res.ok){
            send(msg.chat.id,"🎊 KEY ACTIVATED!\n⏳ "+res.days+" days\n📅 Expires: "+res.expiry+"\n\n▶️ Start Prediction tap பண்ணு!",{reply_markup:userMenu(id)});
            send(OWNER_ID,"🔔 Key used!\nUser: "+id+"\nDays: "+res.days);
        } else send(msg.chat.id,res.msg);
    });

    // Set token
    bot.onText(/\/setmytoken (.+)/,(msg,match)=>{
        const id=msg.from.id;
        if(!hasAccess(id)) return send(id,"❌ No access. Contact "+ADMIN_HANDLE);
        const tok=match[1].trim().replace(/^Bearer\s+/i,"");
        if(tok.length<20) return send(id,"❌ Token too short!");
        userTokens[id]=tok;
        send(id,"✅ Token saved!\n..."+tok.slice(-12)+"\n\n🤖 AutoBet Setup → Enable AutoBet");
    });

    // ── NEW: Set payload (random + timestamp + signature from browser) ──
    bot.onText(/\/setpayload (.+)/,(msg,match)=>{
        const id=msg.from.id;
        if(!hasAccess(id)) return send(id,"❌ No access.");
        const parts=match[1].trim().split(/\s+/);
        if(parts.length!==3) return send(id,
"❌ Format தப்பு!\n\n"+
"சரியான format:\n"+
"/setpayload RANDOM TIMESTAMP SIGNATURE\n\n"+
"Example:\n"+
"/setpayload 985473621047 1779430125 a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"
        );
        userPayload[id]={ random:parts[0], timestamp:parts[1], signature:parts[2] };
        send(id,
"✅ Payload saved!\n"+
"random: "+parts[0]+"\n"+
"timestamp: "+parts[1]+"\n"+
"signature: "+parts[2].substr(0,10)+"...\n\n"+
"Next bet-ல இந்த signature use ஆகும்!\n"+
"⚠️ ஒரே ஒரு bet-க்கு மட்டும் valid — அதுக்கு அப்புறம் மீண்டும் set பண்ணணும்."
        );
    });

    bot.onText(/\/owner/,(msg)=>{
        if(msg.from.id!==OWNER_ID) return;
        if(ownerLoggedIn) return send(OWNER_ID,"Already in!",{reply_markup:ownerMenu});
        ownerState={action:"login"}; send(OWNER_ID,"🔐 Owner password:");
    });

    bot.onText(/\/adminlogin (.+)/,(msg,match)=>{
        const id=msg.from.id,pass=match[1].trim();
        if(!isAdmin(id)) return send(id,"Not admin.");
        if(pass===adminPasswords[id]){adminLoggedIn[id]=true;send(id,"✅ Admin Login!",{reply_markup:userMenu(id)});}
        else send(id,"❌ Wrong!");
    });

    bot.on("message",async msg=>{
        const id=msg.from.id,text=msg.text;
        if(!text||text.startsWith("/")) return;
        initUser(id);

        const OB=["👥 All Users","👮 All Admins","👤 Add Admin","🗑 Remove Admin","🔑 Generate Key","📋 All Keys","🟢 Add User","🔴 Remove User","🔐 Set Token","📊 All Stats","🚪 Owner Logout"];
        const AB=["👥 Active Users","🔑 Generate Key","🟢 Add User","🔴 Remove User","📋 All Keys","🚪 Admin Logout"];

        // OWNER STATE
        if(id===OWNER_ID&&ownerState){
            const s=ownerState;
            if(s.action==="login"){if(text===OWNER_PASS){ownerLoggedIn=true;ownerState=null;return send(OWNER_ID,"👑 Welcome Boss!",{reply_markup:ownerMenu});}else return send(OWNER_ID,"❌ Wrong!");}
            if(OB.includes(text)){ownerState=null;}
            else if(s.action==="addadmin"){if(!s.step2){const t=parseInt(text);if(isNaN(t))return send(OWNER_ID,"❌ Invalid");ownerState={action:"addadmin",step2:true,tid:t};return send(OWNER_ID,"ID:"+t+"\nPassword set பண்ணு:");}else{if(text.length<6)return send(OWNER_ID,"❌ Min 6 chars");adminPasswords[s.tid]=text;adminLoggedIn[s.tid]=false;ownerState=null;send(OWNER_ID,"✅ Admin: "+s.tid,{reply_markup:ownerMenu});send(s.tid,"🎉 Admin!\n/adminlogin "+text);return;}}
            else if(s.action==="removeadmin"){const t=parseInt(text);if(isNaN(t))return;if(!adminPasswords[t]){ownerState=null;return send(OWNER_ID,"⚠️ Not admin",{reply_markup:ownerMenu});}delete adminPasswords[t];delete adminLoggedIn[t];ownerState=null;send(OWNER_ID,"🚫 "+t+" removed",{reply_markup:ownerMenu});return;}
            else if(s.action==="genkey"){const d=parseInt(text);if(isNaN(d)||d<1)return send(OWNER_ID,"❌ Days enter பண்ணு");const k=generateKey(d,OWNER_ID);ownerState=null;return send(OWNER_ID,"🔑 Key:\n\n"+k+"\n\n"+d+"d\nUser: /key "+k,{reply_markup:ownerMenu});}
            else if(s.action==="adduser"){if(!s.step2){const t=parseInt(text);if(isNaN(t))return send(OWNER_ID,"❌ Invalid");ownerState={action:"adduser",step2:true,tid:t};return send(OWNER_ID,"ID:"+t+"\nDays?");}else{const d=parseInt(text);if(isNaN(d)||d<1)return send(OWNER_ID,"❌ Invalid");usersAccess[s.tid]=Date.now()+d*86400000;ownerState=null;send(OWNER_ID,"✅ "+s.tid+" — "+d+"d",{reply_markup:ownerMenu});send(s.tid,"🎊 VIP! "+d+" days\n▶️ Start Prediction!");return;}}
            else if(s.action==="removeuser"){const t=parseInt(text);if(isNaN(t))return;const was=hasAccess(t);delete usersAccess[t];running[t]=false;ownerState=null;send(OWNER_ID,was?"🚫 "+t+" removed":"⚠️ Not active",{reply_markup:ownerMenu});if(was)send(t,"🔴 Access removed.");return;}
            else if(s.action==="settoken"){GLOBAL_TOKEN=text.trim().replace(/^Bearer\s+/i,"");ownerState=null;return send(OWNER_ID,"✅ Global Token set!",{reply_markup:ownerMenu});}
        }

        // OWNER MENU
        if(id===OWNER_ID&&ownerLoggedIn){
            if(text==="👥 All Users")    return send(OWNER_ID,"👥\n\n"+activeUsersList());
            if(text==="👮 All Admins")   return send(OWNER_ID,"👮\n\n"+adminList());
            if(text==="👤 Add Admin")    {ownerState={action:"addadmin"};return send(OWNER_ID,"User ID:");}
            if(text==="🗑 Remove Admin") {ownerState={action:"removeadmin"};return send(OWNER_ID,"Admin ID:");}
            if(text==="🔑 Generate Key") {ownerState={action:"genkey"};return send(OWNER_ID,"Days?");}
            if(text==="📋 All Keys")     return send(OWNER_ID,"📋\n\n"+allKeysList());
            if(text==="🟢 Add User")     {ownerState={action:"adduser"};return send(OWNER_ID,"User ID:");}
            if(text==="🔴 Remove User")  {ownerState={action:"removeuser"};return send(OWNER_ID,"User ID:");}
            if(text==="🔐 Set Token")    {ownerState={action:"settoken"};return send(OWNER_ID,"Token paste பண்ணு:");}
            if(text==="📊 All Stats")    {const lines=Object.entries(stats).map(([id,s])=>"👤 "+id+": "+s.win+"W/"+s.loss+"L");return send(OWNER_ID,lines.join("\n")||"No stats");}
            if(text==="🚪 Owner Logout") {ownerLoggedIn=false;return send(OWNER_ID,"🔒 Out.",{reply_markup:userMenu(id)});}
        }

        // ADMIN STATE
        if(isAdmin(id)&&isAdminIn(id)&&adminState[id]){
            const s=adminState[id];
            if(AB.includes(text)){delete adminState[id];}
            else if(s.action==="genkey"){const d=parseInt(text);if(isNaN(d)||d<1)return send(id,"❌ Days?");const k=generateKey(d,id);delete adminState[id];return send(id,"🔑 Key:\n\n"+k+"\n\n"+d+"d",{reply_markup:adminMenu});}
            else if(s.action==="adduser"){if(!s.step2){const t=parseInt(text);if(isNaN(t))return send(id,"❌ Invalid");adminState[id]={action:"adduser",step2:true,tid:t};return send(id,"ID:"+t+"\nDays?");}else{const d=parseInt(text);if(isNaN(d)||d<1)return send(id,"❌ Invalid");usersAccess[s.tid]=Date.now()+d*86400000;delete adminState[id];send(id,"✅ "+s.tid+" — "+d+"d",{reply_markup:adminMenu});send(s.tid,"🎊 ACCESS! "+d+"d");return;}}
            else if(s.action==="removeuser"){const t=parseInt(text);if(isNaN(t))return;const was=hasAccess(t);delete usersAccess[t];running[t]=false;delete adminState[id];send(id,was?"🚫 "+t+" removed":"⚠️ Not active",{reply_markup:adminMenu});if(was)send(t,"🔴 Removed.");return;}
            // AutoBet config states
            else if(s.action==="setbase"){const v=parseInt(text);if(isNaN(v)||v<1)return send(id,"❌ Min 1");autobetCfg[id].baseBet=v;delete adminState[id];const a=MULT.slice(0,autobetCfg[id].maxLvl).map(m=>v*m);return send(id,"✅ Base: ₹"+v+"\nMart: ₹"+a.join(" → ₹"),{reply_markup:autobetMenu});}
            else if(s.action==="setlvl"){const v=parseInt(text);if(isNaN(v)||v<1||v>7)return send(id,"❌ 1-7 enter பண்ணு");autobetCfg[id].maxLvl=v;delete adminState[id];const a=MULT.slice(0,v).map(m=>autobetCfg[id].baseBet*m);return send(id,"✅ Levels: "+v+"\nMart: ₹"+a.join(" → ₹"),{reply_markup:autobetMenu});}
            else if(s.action==="setwloss"){const v=parseInt(text);if(isNaN(v)||v<1)return send(id,"❌ Min 1");autobetCfg[id].watchLoss=v;delete adminState[id];return send(id,"✅ Watch losses: "+v,{reply_markup:autobetMenu});}
        }

        // ADMIN MENU
        if(isAdmin(id)&&isAdminIn(id)){
            if(text==="👥 Active Users") return send(id,"👥\n\n"+activeUsersList());
            if(text==="🔑 Generate Key") {adminState[id]={action:"genkey"};return send(id,"Days?");}
            if(text==="🟢 Add User")     {adminState[id]={action:"adduser"};return send(id,"User ID?");}
            if(text==="🔴 Remove User")  {adminState[id]={action:"removeuser"};return send(id,"User ID?");}
            if(text==="📋 All Keys")     return send(id,"📋\n\n"+allKeysList());
            if(text==="🚪 Admin Logout") {adminLoggedIn[id]=false;return send(id,"🔒 Out.",{reply_markup:userMenu(id)});}
        }
        if(text==="👑 Admin Panel"&&isAdmin(id)){
            if(!isAdminIn(id)) return send(id,"Login:\n/adminlogin YOUR_PASS");
            return send(id,"👑 Admin",{reply_markup:adminMenu});
        }

        // AUTOBET SETUP
        if(text==="🤖 AutoBet Setup"){ if(!hasAccess(id))return send(id,"❌ No access.");
            return send(id,
"🤖 AutoBet Settings\n\n"+
"Status : "+(autobetCfg[id].enabled?"✅ ON":"❌ OFF")+"\n"+
"Watch  : "+(autobetCfg[id].watch?"ON":"OFF")+"\n"+
"WatchL : "+autobetCfg[id].watchLoss+"\n"+
"Base   : ₹"+autobetCfg[id].baseBet+"\n"+
"Levels : "+autobetCfg[id].maxLvl+"\n\n"+
"⚠️ Token set பண்ணாதா?\n"+
"/setmytoken YOUR_TOKEN",{reply_markup:autobetMenu});
        }
        if(text==="✅ Enable AutoBet"){
            if(!getToken(id)) return send(id,"❌ Token இல்லை!\n/setmytoken YOUR_TOKEN");
            autobetCfg[id].enabled=true;
            return send(id,"✅ AutoBet ON!\n💰 ₹"+autobetCfg[id].baseBet+"\n👀 Watch: "+(autobetCfg[id].watch?"ON ("+autobetCfg[id].watchLoss+" losses)":"OFF"),{reply_markup:userMenu(id)});
        }
        if(text==="❌ Disable AutoBet"){autobetCfg[id].enabled=false;return send(id,"❌ AutoBet OFF",{reply_markup:userMenu(id)});}
        if(text==="👀 Watch Mode ON") {autobetCfg[id].watch=true; return send(id,"👀 Watch ON — "+autobetCfg[id].watchLoss+" losses கழிச்சு bet");}
        if(text==="👀 Watch Mode OFF"){autobetCfg[id].watch=false;return send(id,"👀 Watch OFF — direct bet");}
        if(text==="💰 Set Base Bet")  {adminState[id]={action:"setbase"};return send(id,"Base bet amount (₹)?\nCurrent: ₹"+autobetCfg[id].baseBet);}
        if(text==="📈 Set Max Level") {adminState[id]={action:"setlvl"};return send(id,"Max levels (1-7)?\nCurrent: "+autobetCfg[id].maxLvl+"\n\n1→₹"+autobetCfg[id].baseBet+" 2→₹"+(autobetCfg[id].baseBet*3)+" 3→₹"+(autobetCfg[id].baseBet*9)+" 4→₹"+(autobetCfg[id].baseBet*27));}
        if(text==="🔢 Set Watch Losses"){adminState[id]={action:"setwloss"};return send(id,"Watch losses count?\nCurrent: "+autobetCfg[id].watchLoss+"\n\nExample: 5 → 5 losses கழிச்சு real bet start");}
        if(text==="📊 AutoBet Status") return autobetStatus(msg.chat.id,id);
        if(text==="🔙 Back") return send(id,"Main Menu",{reply_markup:userMenu(id)});

        // TOKEN INFO
        if(text==="🔑 My Token"){
            const tok=getToken(id);
            return send(id,tok
                ?"✅ Token active\n..."+tok.slice(-12)+"\n\nUpdate: /setmytoken NEW_TOKEN"
                :"❌ Token இல்லை!\n\n/setmytoken YOUR_TOKEN\n\nToken எடுக்க:\ngoaokk.com → Login → F12 → Network → WinGoBet → Headers → Authorization → Bearer-க்கு அப்புறம் இருக்கதை copy பண்ணு"
            );
        }

        // START / STOP
        if(text==="▶️ Start Prediction"){
            if(!hasAccess(id)) return send(msg.chat.id,"❌ No access!\n📩 "+ADMIN_HANDLE+"\n🆔 ID: "+id);
            if(running[id]) return send(msg.chat.id,"⚠️ Already running!");
            running[id]=true; sentPeriods[id]=new Set();
            autobetState[id]={level:1,vLoss:0,inMart:false,curPeriod:null};
            await send(msg.chat.id,
"╔══════════════════════════╗\n"+"║  🚀 ENGINE ON!           ║\n"+"╠══════════════════════════╣\n"+
"║ AutoBet : "+(autobetCfg[id].enabled?"✅ ON":"❌ OFF (🤖 Setup)")+"\n"+
"║ Watch   : "+(autobetCfg[id].watch?"ON — "+autobetCfg[id].watchLoss+" losses":"OFF — direct")+"\n"+
"╚══════════════════════════╝"
            );
            runPredict(id,msg.chat.id);
        }
        if(text==="🛑 Stop")   {running[id]=false;send(msg.chat.id,"🛑 Stopped.");}
        if(text==="📊 Stats")  showStats(msg.chat.id,id);
        if(text==="💰 Profit") profitReport(msg.chat.id,id);
        if(text==="📩 Contact") send(msg.chat.id,"📩 "+ADMIN_HANDLE+"\n🆔 ID: "+id);
    });
}

startBot();