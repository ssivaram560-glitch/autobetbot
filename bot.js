const TelegramBot = require('node-telegram-bot-api');
const axios       = require('axios');
const crypto      = require('crypto');
const zlib        = require('zlib');

// ============================================================
//  CONFIG
// ============================================================
const BOT_TOKEN    = "8678093059:AAEkXmAGdWzl9ytR_Z2tlw3n6Ki5vY5XA1k";
const OWNER_ID     = 8321379592;
const OWNER_PASS   = "2004";
const ADMIN_HANDLE = "@OnlineEarningapp_bot";
const REG_LINK     = "https://www.goaoko.com/#/register?invitationCode=457367799017";
const WIN_STICKER  = "CAACAgUAAxkBAAFHUGNp4JX1-ohP4uBEWpfNptaz-HmwVgAC4hgAAhboKVbObuGuTcMs2zsE";
const LOSS_STICKER = "CAACAgUAAxkBAAFHUGVp4JX-BE2TRkhIKTwcjkwW-gzdPAACthoAAoG8YVYiydObSa0O8zsE";

const BET_URL      = "https://api.ar-lottery01.com/api/Lottery/WinGoBet";
const LOGIN_URL    = "https://api.goa7777.com/api/webapi/Login";
const CAPTCHA_URL  = "https://api.goa7777.com/api/webapi/GetCaptcha";
const DRAW_URL     = "https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json";

const MULT = [1,3,7,18,38,74,170,400,850,1900];

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
let userCreds      = {};   // userId -> { phone, pass, deviceId }
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
    if (!autobetCfg[id])   autobetCfg[id]   = { watch:true, watchLoss:2, baseBet:1, maxLvl:10, enabled:false };
    if (!autobetState[id]) autobetState[id] = { level:1, consecutiveLoss:0, inMart:false };
    if (!profitTrack[id])  profitTrack[id]  = { totalBets:0, wins:0, losses:0, pnl:0, winStreak:0, lossStreak:0, maxW:0, maxL:0 };
}
function hasAccess(id)  { return !!(usersAccess[id] && Date.now() < usersAccess[id]); }
function daysLeft(id)   { return usersAccess[id] ? ((usersAccess[id]-Date.now())/86400000).toFixed(1) : "0"; }
function isAdmin(id)    { return adminPasswords[id] !== undefined; }
function isAdminIn(id)  { return adminLoggedIn[id] === true; }
function sleep(ms)      { return new Promise(r => setTimeout(r, ms)); }
function getToken(id)   { return userTokens[id] || GLOBAL_TOKEN || ""; }

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
//  DEVICE ID — UUID format like browser: "1ee02b32131314688453c6adde9f2ffa"
// ============================================================
function getOrCreateDevice(userId) {
    if (!userCreds[userId]) userCreds[userId] = {};
    if (!userCreds[userId].deviceId) {
        userCreds[userId].deviceId = crypto.randomBytes(16).toString('hex');
    }
    return userCreds[userId].deviceId;
}

// ============================================================
//  LOGIN SIGNATURE — CONFIRMED FROM BROWSER DEVTOOLS
//  Payload from browser:
//    username:  "916381605525"  (country code + number)
//    phonetype: 0               (number, NOT 1)
//    language:  0               (number)
//    random:    "46c3c9f6..."   (hex string)
//    captchaId: "ac7e4fc3-..."  (UUID)
//    deviceId:  "1ee02b32..."   (hex)
//    logintype: "mobile"
//    packId:    ""
//    pwd:       "password"
//    timestamp: 1779589644      (excluded from signature)
//    track:     {...}           (excluded from signature)
//
//  Signature = MD5(JSON.stringify(sorted_params_without_timestamp_track_empty))
//  Result: "CC6E069BCA508301EB4094C2DD1212C5" ✅
// ============================================================
function makeLoginSign(params) {
    const p = {...params};
    delete p.signature;
    delete p.timestamp;
    delete p.track;

    // Filter: exclude null, empty string, objects
    const keys = Object.keys(p).filter(k => {
        const v = p[k];
        if (v === null || v === undefined) return false;
        if (v === "") return false;
        if (typeof v === 'object') return false;
        return true;
    }).sort();

    const sorted = {};
    keys.forEach(k => { sorted[k] = p[k]; });

    const str = JSON.stringify(sorted);
    console.log("[LOGIN SIG INPUT]", str);
    const sig = crypto.createHash('md5').update(str).digest('hex').toUpperCase().slice(0,32);
    console.log("[LOGIN SIG]", sig);
    return sig;
}

// ============================================================
//  BET SIGNATURE — Same algorithm
// ============================================================
function makeBetSign(params) {
    const p = {...params};
    delete p.signature;
    delete p.timestamp;
    const keys = Object.keys(p).filter(k=>p[k]!==null&&p[k]!=="").sort();
    const sorted = {};
    keys.forEach(k=>{ sorted[k]=p[k]===0?0:p[k]; });
    return crypto.createHash('md5').update(JSON.stringify(sorted)).digest('hex').toUpperCase().slice(0,32);
}

// ============================================================
//  FETCH CAPTCHA — Required for login
// ============================================================
async function fetchCaptcha() {
    try {
        const r = await axios.get(CAPTCHA_URL, {
            headers: {
                "Accept": "application/json, text/plain, */*",
                "Origin": "https://goaokk.com",
                "Referer": "https://goaokk.com/",
                "Ar-Origin": "https://goaokk.com",
                "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36"
            },
            timeout: 10000
        });
        if (r.data?.code === 0 && r.data?.data?.captchaId) {
            console.log("[CAPTCHA] ID:", r.data.data.captchaId);
            return r.data.data.captchaId;
        }
        console.log("[CAPTCHA] No captchaId:", JSON.stringify(r.data).substr(0,100));
        return "";
    } catch(e) {
        console.error("[CAPTCHA ERR]", e.message);
        return "";
    }
}

// ============================================================
//  AUTO LOGIN — EXACT BROWSER PAYLOAD
// ============================================================
let loginLock = {};

async function autoLogin(userId, chatId, silent=false) {
    if (loginLock[userId]) { console.log("[LOGIN] Lock active for", userId); return false; }
    loginLock[userId] = true;

    const creds = userCreds[userId] || {};
    const phone = creds.phone;
    const pass  = creds.pass;

    if (!phone || !pass) {
        loginLock[userId] = false;
        if (!silent && chatId) await send(chatId,
"❌ Phone/Password இல்லை!\n\n"+
"Format:\n/setcreds FULLPHONE PASSWORD\n\n"+
"Example (India +91):\n/setcreds 916381605525 suthamari6381\n\n"+
"Note: Phone = country code + number\n"+
"India: 91 + 6381605525 = 916381605525"
        );
        return false;
    }

    // Step 1: Fetch captcha UUID
    const captchaId = await fetchCaptcha();

    const deviceId = getOrCreateDevice(userId);
    // random = hex string (confirmed from browser)
    const rand = crypto.randomBytes(16).toString('hex');
    const ts   = Math.floor(Date.now() / 1000);

    // EXACT payload matching browser DevTools
    const payload = {
        captchaId:  captchaId,      // UUID from GetCaptcha API
        deviceId:   deviceId,       // hex string
        language:   0,              // number 0
        logintype:  "mobile",
        packId:     "",
        phonetype:  0,              // number 0 (confirmed from browser!)
        pwd:        pass,
        random:     rand,           // hex string (confirmed!)
        timestamp:  ts,
        username:   phone,          // full: "916381605525"
        track: {
            backgroundImageWidth:  340,
            backgroundImageHeight: 212,
            sliderImageWidth:      68,
            sliderImageHeight:     212
        }
    };

    // Generate signature (excludes timestamp, track, empty captchaId if empty)
    payload.signature = makeLoginSign(payload);

    console.log("[LOGIN] User:", phone, "Rand:", rand.slice(0,8), "CaptchaId:", captchaId.slice(0,8)||"none");

    try {
        const r = await axios.post(LOGIN_URL, payload, {
            headers: {
                "content-type": "application/json;charset=UTF-8",
                "Accept":       "application/json, text/plain, */*",
                "Origin":       "https://goaokk.com",
                "Referer":      "https://goaokk.com/",
                "Ar-Origin":    "https://goaokk.com",
                "User-Agent":   "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36"
            },
            timeout: 12000
        });

        const res = r.data;
        console.log("[LOGIN RESP] code:", res.code, "msg:", res.msg);

        if (res.code === 0 && res.data?.token) {
            userTokens[userId] = res.data.token;
            console.log("[LOGIN OK] Token:...", res.data.token.slice(-10));
            if (!silent && chatId) await send(chatId,
"✅ Login Success!\n"+
"📱 "+phone+"\n"+
"🔑 Token auto-refreshed!\n\n"+
"AutoBet இப்போ work ஆகும்!"
            );
            loginLock[userId] = false;
            return true;
        }

        if (res.msg?.toLowerCase().includes("captcha") || res.msg?.toLowerCase().includes("verify")) {
            if (!silent && chatId) await send(chatId,
"⚠️ Captcha required!\n\n"+
"Slider captcha bypass பண்ண முடியல.\n"+
"Manual token use பண்ணு:\n"+
"/setmytoken TOKEN\n\n"+
"Token: goaokk.com → Login → F12 → Network → WinGoBet → Authorization"
            );
            loginLock[userId] = false;
            return false;
        }

        console.log("[LOGIN FAIL]", JSON.stringify(res).substr(0,150));
        if (!silent && chatId) await send(chatId, "❌ Login fail: " + (res.msg || "code:"+res.code));
        loginLock[userId] = false;
        return false;

    } catch(err) {
        console.error("[LOGIN ERR]", err.message);
        if (!silent && chatId) await send(chatId, "❌ Login error: " + err.message);
        loginLock[userId] = false;
        return false;
    }
}

// ============================================================
//  PLACE BET
// ============================================================
async function placeBet(userId, chatId, period, prediction, predType, level) {
    let token = getToken(userId);
    if (!token || token.length < 20) {
        const ok = await autoLogin(userId, chatId, true);
        if (!ok) { await send(chatId,"❌ Token இல்லை!\n/setmytoken TOKEN\nor\n/setcreds FULLPHONE PASSWORD"); return false; }
        token = getToken(userId);
    }

    const cfg     = autobetCfg[userId];
    const betMult = cfg.baseBet * MULT[level-1];
    let bc = "";
    if (predType==="SIZE")  bc = prediction==="BIG" ? "BigSmall_Big" : "BigSmall_Small";
    if (predType==="COLOR") bc = prediction==="RED" ? "Color_Red"    : "Color_Green";

    const params = {
        amount:      1,
        betContent:  bc,
        betMultiple: betMult,
        gameCode:    "WinGo_1M",
        issueNumber: String(period),
        language:    "en",
        random:      Math.floor(Math.random()*1e12)
    };
    const signature = makeBetSign(params);
    const timestamp = Math.floor(Date.now()/1000);
    const payload   = {...params, signature, timestamp};

    console.log(`[BET] ${bc} ₹${betMult} L${level} Period:${String(period).slice(-6)}`);

    try {
        const r = await axios.post(BET_URL, payload, {
            headers: {
                "authorization":    "Bearer "+token,
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
            },
            timeout: 10000
        });
        const d = r.data;
        console.log(`[BET RESP] code:${d.code} msg:${d.msg}`);

        if (d.code===0||d.msg==="Succeed"||d.msgCode===0) return {ok:true, amt:betMult, bc};

        if (d.code===401||d.code===40100||(d.msg&&(d.msg.toLowerCase().includes("token")||d.msg.toLowerCase().includes("expired")))) {
            userTokens[userId]="";
            await send(chatId,"🔄 Token expired — Re-login...");
            const ok = await autoLogin(userId,chatId,true);
            if(ok) await send(chatId,"✅ Re-login OK!");
            else   await send(chatId,"❌ Re-login fail! /setcreds பண்ணு.");
            return false;
        }

        await send(chatId,"❌ Bet fail: "+(d.msg||JSON.stringify(d).substr(0,60)));
        return false;
    } catch(err) {
        console.error("[BET ERR]",err.message);
        await send(chatId,"❌ Network error: "+err.message);
        return false;
    }
}

// ============================================================
//  PREDICTION ENGINE
// ============================================================
function parseResult(item) {
    const n=parseInt(item.number);
    return {n, size:n>=5?"BIG":"SMALL", color:n===0?"RED":n===5?"GREEN":n%2===0?"RED":"GREEN"};
}
function stk(arr,k){let c=1;for(let i=1;i<arr.length;i++){if(arr[i][k]===arr[0][k])c++;else break;}return{val:arr[0][k],count:c};}
function cnt(arr,k,v){return arr.filter(x=>x[k]===v).length;}
function isAlt(arr,k,n){for(let i=0;i<n-1;i++){if(arr[i][k]===arr[i+1][k])return false;}return true;}
function isDbl(arr,k){if(arr.length<8)return false;return arr[0][k]===arr[1][k]&&arr[2][k]===arr[3][k]&&arr[4][k]===arr[5][k]&&arr[6][k]===arr[7][k]&&arr[0][k]!==arr[2][k]&&arr[2][k]!==arr[4][k];}
function isTrp(arr,k){if(arr.length<6)return false;return arr[0][k]===arr[1][k]&&arr[1][k]===arr[2][k]&&arr[3][k]===arr[4][k]&&arr[4][k]===arr[5][k]&&arr[0][k]!==arr[3][k];}
function isDragon(arr,k){return stk(arr,k).count>=6;}

function detectSignal(list) {
    const data=list.slice(0,20).map(parseResult);
    const d5=data.slice(0,5),d6=data.slice(0,6),d8=data.slice(0,8);
    const d10=data.slice(0,10),d15=data.slice(0,15),d20=data.slice(0,20);
    const c=[];
    const szS=stk(d10,"size"),clS=stk(d10,"color");
    const sizeDragon=isDragon(d10,"size"),colorDragon=isDragon(d10,"color");

    // SIZE
    if(szS.count>=5&&szS.count<6)c.push({type:"SIZE",val:szS.val==="BIG"?"SMALL":"BIG",conf:95,pat:"5 STREAK BREAK"});
    else if(szS.count===4)c.push({type:"SIZE",val:szS.val==="BIG"?"SMALL":"BIG",conf:91,pat:"4 STREAK BREAK"});
    else if(szS.count===3)c.push({type:"SIZE",val:szS.val==="BIG"?"SMALL":"BIG",conf:90,pat:"3 STREAK BREAK"});
    if(szS.count>=8)c.push({type:"SIZE",val:szS.val,conf:90,pat:"DRAGON RIDE "+szS.count+"+"});
    if(isAlt(d6,"size",6))c.push({type:"SIZE",val:d6[0].size==="BIG"?"SMALL":"BIG",conf:93,pat:"PERFECT ALT-6"});
    else if(isAlt(d5,"size",4))c.push({type:"SIZE",val:d5[0].size==="BIG"?"SMALL":"BIG",conf:90,pat:"PERFECT ALT-4"});
    if(!sizeDragon){
        const b20=cnt(d20,"size","BIG"),s20=cnt(d20,"size","SMALL");
        if(b20>=15)c.push({type:"SIZE",val:"SMALL",conf:91,pat:"15+/20 BIG→REV"});
        if(s20>=15)c.push({type:"SIZE",val:"BIG",conf:91,pat:"15+/20 SML→REV"});
        if(b20>=13)c.push({type:"SIZE",val:"SMALL",conf:90,pat:"13/20 BIG→REV"});
        if(s20>=13)c.push({type:"SIZE",val:"BIG",conf:90,pat:"13/20 SML→REV"});
        const b15=cnt(d15,"size","BIG"),s15=cnt(d15,"size","SMALL");
        if(b15>=12)c.push({type:"SIZE",val:"SMALL",conf:91,pat:"12/15 BIG→REV"});
        if(s15>=12)c.push({type:"SIZE",val:"BIG",conf:91,pat:"12/15 SML→REV"});
        const b10=cnt(d10,"size","BIG"),s10=cnt(d10,"size","SMALL");
        if(b10>=9)c.push({type:"SIZE",val:"SMALL",conf:94,pat:"9+/10 BIG→REV"});
        if(s10>=9)c.push({type:"SIZE",val:"BIG",conf:94,pat:"9+/10 SML→REV"});
        if(b10===8)c.push({type:"SIZE",val:"SMALL",conf:91,pat:"8/10 BIG→REV"});
        if(s10===8)c.push({type:"SIZE",val:"BIG",conf:91,pat:"8/10 SML→REV"});
    }
    if(isDbl(d8,"size"))c.push({type:"SIZE",val:d8[6].size==="BIG"?"SMALL":"BIG",conf:91,pat:"DOUBLE PAIR"});
    if(isTrp(d6,"size"))c.push({type:"SIZE",val:d6[3].size,conf:91,pat:"TRIPLE PAIR"});

    // COLOR
    if(clS.count>=5&&clS.count<6)c.push({type:"COLOR",val:clS.val==="RED"?"GREEN":"RED",conf:95,pat:"5 STREAK BREAK"});
    else if(clS.count===4)c.push({type:"COLOR",val:clS.val==="RED"?"GREEN":"RED",conf:91,pat:"4 STREAK BREAK"});
    else if(clS.count===3)c.push({type:"COLOR",val:clS.val==="RED"?"GREEN":"RED",conf:90,pat:"3 STREAK BREAK"});
    if(clS.count>=8)c.push({type:"COLOR",val:clS.val,conf:90,pat:"DRAGON RIDE "+clS.count+"+"});
    if(isAlt(d6,"color",6))c.push({type:"COLOR",val:d6[0].color==="RED"?"GREEN":"RED",conf:93,pat:"PERFECT ALT-6"});
    else if(isAlt(d5,"color",4))c.push({type:"COLOR",val:d5[0].color==="RED"?"GREEN":"RED",conf:90,pat:"PERFECT ALT-4"});
    if(!colorDragon){
        const r20=cnt(d20,"color","RED"),g20=cnt(d20,"color","GREEN");
        if(r20>=15)c.push({type:"COLOR",val:"GREEN",conf:91,pat:"15+/20 RED→REV"});
        if(g20>=15)c.push({type:"COLOR",val:"RED",conf:91,pat:"15+/20 GRN→REV"});
        if(r20>=13)c.push({type:"COLOR",val:"GREEN",conf:90,pat:"13/20 RED→REV"});
        if(g20>=13)c.push({type:"COLOR",val:"RED",conf:90,pat:"13/20 GRN→REV"});
        const r15=cnt(d15,"color","RED"),g15=cnt(d15,"color","GREEN");
        if(r15>=12)c.push({type:"COLOR",val:"GREEN",conf:91,pat:"12/15 RED→REV"});
        if(g15>=12)c.push({type:"COLOR",val:"RED",conf:91,pat:"12/15 GRN→REV"});
        const r10=cnt(d10,"color","RED"),g10=cnt(d10,"color","GREEN");
        if(r10>=9)c.push({type:"COLOR",val:"GREEN",conf:94,pat:"9+/10 RED→REV"});
        if(g10>=9)c.push({type:"COLOR",val:"RED",conf:94,pat:"9+/10 GRN→REV"});
        if(r10===8)c.push({type:"COLOR",val:"GREEN",conf:91,pat:"8/10 RED→REV"});
        if(g10===8)c.push({type:"COLOR",val:"RED",conf:91,pat:"8/10 GRN→REV"});
    }
    if(isDbl(d8,"color"))c.push({type:"COLOR",val:d8[6].color==="RED"?"GREEN":"RED",conf:91,pat:"DOUBLE PAIR"});
    if(isTrp(d6,"color"))c.push({type:"COLOR",val:d6[3].color,conf:91,pat:"TRIPLE PAIR"});

    if(!c.length)return null;
    c.sort((a,b)=>b.conf-a.conf);
    return c[0].conf>=90?c[0]:null;
}

// ============================================================
//  FETCH HISTORY
// ============================================================
function decodeBuffer(buf) {
    try{return JSON.parse(buf.toString("utf8"));}catch(e){}
    try{return JSON.parse(zlib.gunzipSync(buf).toString("utf8"));}catch(e){}
    try{return JSON.parse(zlib.inflateSync(buf).toString("utf8"));}catch(e){}
    try{return JSON.parse(zlib.inflateRawSync(buf).toString("utf8"));}catch(e){}
    try{return JSON.parse(zlib.brotliDecompressSync(buf).toString("utf8"));}catch(e){}
    return null;
}
async function fetchList(retries=3) {
    for(let i=0;i<retries;i++){
        try{
            const res=await axios.get(DRAW_URL+"?ts="+Date.now(),{
                headers:{"User-Agent":"Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36","Accept":"application/json, text/plain, */*","Accept-Encoding":"gzip, deflate, br","Origin":"https://goaokk.com","Referer":"https://goaokk.com/"},
                timeout:10000,decompress:true,responseType:"arraybuffer"
            });
            const data=decodeBuffer(Buffer.from(res.data));
            if(!data)continue;
            const list=data?.data?.list;
            if(list&&list.length>0)return list;
        }catch(e){console.error("Fetch",i+1,":",e.message);if(i<retries-1)await sleep(3000);}
    }
    return null;
}

// ============================================================
//  AUTOBET LOGIC
// ============================================================
function shouldBetNow(userId) {
    const cfg=autobetCfg[userId],st=autobetState[userId];
    if(!cfg.enabled)return false;
    if(!getToken(userId))return false;
    if(st.inMart)return true;
    if(!cfg.watch)return true;
    return st.consecutiveLoss>=cfg.watchLoss;
}

async function handleWin(userId, chatId, actual, num) {
    const st=autobetState[userId],pt=profitTrack[userId],cfg=autobetCfg[userId];
    const amt=cfg.baseBet*MULT[st.level-1],profit=amt*0.98;
    pt.totalBets++;pt.wins++;pt.pnl+=profit;
    pt.winStreak++;pt.lossStreak=0;if(pt.winStreak>pt.maxW)pt.maxW=pt.winStreak;
    st.level=1;st.inMart=false;st.consecutiveLoss=0;
    await send(chatId,
"╔══════════════════════════╗\n"+
"║  ✅  WIN! 🎉🎊           ║\n"+
"╠══════════════════════════╣\n"+
"║ 🔢 Number : "+num+"\n"+
"║ 🎯 Result : "+actual+"\n"+
"║ 💰 Profit : +₹"+profit.toFixed(2)+"\n"+
"║ 📊 P&L    : "+(pt.pnl>=0?"+":"")+pt.pnl.toFixed(2)+"\n"+
"║ 🔥 Streak : "+pt.winStreak+" wins\n"+
"║ 📈 Total  : "+pt.wins+"W / "+pt.losses+"L\n"+
"║ 🔄 Reset → L1, Watch 0/"+cfg.watchLoss+"\n"+
"╚══════════════════════════╝"
    );
    await sendSticker(chatId,WIN_STICKER);
}

async function handleLoss(userId, chatId, actual, num) {
    const st=autobetState[userId],pt=profitTrack[userId],cfg=autobetCfg[userId];
    const amt=cfg.baseBet*MULT[st.level-1];
    pt.totalBets++;pt.losses++;pt.pnl-=amt;
    pt.lossStreak++;pt.winStreak=0;if(pt.lossStreak>pt.maxL)pt.maxL=pt.lossStreak;
    if(st.level<cfg.maxLvl){
        st.level++;st.inMart=true;
        const next=cfg.baseBet*MULT[st.level-1];
        await send(chatId,
"╔══════════════════════════╗\n"+
"║  ❌  LOSS                ║\n"+
"╠══════════════════════════╣\n"+
"║ 🔢 Number : "+num+"\n"+
"║ 🎯 Result : "+actual+"\n"+
"║ 💸 Loss   : -₹"+amt+"\n"+
"║ 📊 P&L    : "+(pt.pnl>=0?"+":"")+pt.pnl.toFixed(2)+"\n"+
"╠══════════════════════════╣\n"+
"║ 📈 Next L"+st.level+" : ₹"+next+"\n"+
"╚══════════════════════════╝"
        );
        await sendSticker(chatId,LOSS_STICKER);
    } else {
        st.level=1;st.inMart=false;st.consecutiveLoss=0;
        await send(chatId,
"╔══════════════════════════╗\n"+
"║  💀 MAX LEVEL LOSS       ║\n"+
"╠══════════════════════════╣\n"+
"║ 💸 Loss   : -₹"+amt+"\n"+
"║ 📊 P&L    : "+(pt.pnl>=0?"+":"")+pt.pnl.toFixed(2)+"\n"+
"║ 🔄 Reset → L1, Watch 0/"+cfg.watchLoss+"\n"+
"╚══════════════════════════╝"
        );
        await sendSticker(chatId,LOSS_STICKER);
    }
}

// ============================================================
//  PREDICT LOOP
// ============================================================
async function runPredict(userId, chatId) {
    if(!running[userId])return;
    const list=await fetchList();
    if(!list){
        await send(chatId,"⚠️ API error, retry...");
        return setTimeout(()=>runPredict(userId,chatId),10000);
    }
    const next=(BigInt(list[0].issueNumber)+1n).toString();
    const signal=detectSignal(list);

    const data10=list.slice(0,10).map(i=>{const n=parseInt(i.number);return{size:n>=5?"BIG":"SMALL",color:n===0?"RED":n===5?"GREEN":n%2===0?"RED":"GREEN"};});
    const szS=stk(data10,"size"),clS=stk(data10,"color");
    const dragonInfo=szS.count>=6?"🐉 SIZE: "+szS.val+" x"+szS.count:clS.count>=6?"🐉 COLOR: "+clS.val+" x"+clS.count:"";

    if(!signal){
        const sk="SK_"+next;
        if(!sentPeriods[userId].has(sk)){
            sentPeriods[userId].add(sk);
            await send(chatId,
"╔══════════════════════════╗\n"+
"║   ⏭️  SKIP               ║\n"+
"╠══════════════════════════╣\n"+
"║ 📅 Period: "+next.slice(-6)+"\n"+
(dragonInfo?"║ "+dragonInfo+"\n":"")+
"║ 🚫 No 90%+ safe pattern\n"+
"║ ⏳ Waiting...\n"+
"╚══════════════════════════╝"
            );
        }
        return setTimeout(()=>runPredict(userId,chatId),20000);
    }

    if(sentPeriods[userId].has(next))return setTimeout(()=>runPredict(userId,chatId),5000);
    sentPeriods[userId].add(next);
    if(sentPeriods[userId].size>50)sentPeriods[userId]=new Set([...sentPeriods[userId]].slice(-50));

    const st=autobetState[userId],cfg=autobetCfg[userId];
    const confBar="🟦".repeat(Math.round(signal.conf/10))+"⬜".repeat(10-Math.round(signal.conf/10));
    const predDisplay=signal.type==="SIZE"?(signal.val==="BIG"?"🔵 BIG (5-9)":"🟠 SMALL (0-4)"):(signal.val==="RED"?"🔴 RED":"🟢 GREEN");

    let abLine="🤖 AutoBet: OFF";
    if(cfg.enabled){
        if(st.inMart) abLine="📈 MART L"+st.level+": ₹"+(cfg.baseBet*MULT[st.level-1]);
        else if(cfg.watch&&st.consecutiveLoss<cfg.watchLoss) abLine="👀 Watch: "+st.consecutiveLoss+"/"+cfg.watchLoss+" losses";
        else abLine="💰 BET: ₹"+(cfg.baseBet*MULT[st.level-1])+" L"+st.level;
    }

    await send(chatId,
"╔══════════════════════════╗\n"+
"║  👑 SIVA ULTRA AI        ║\n"+
"╠══════════════════════════╣\n"+
"║ 📅 Period : "+next.slice(-6)+"\n"+
"║ 🎯 Signal : "+predDisplay+"\n"+
"║ 🏆 Pattern: "+signal.pat+"\n"+
"║ 🔥 Conf   : "+signal.conf+"%\n"+
"║ "+confBar+"\n"+
"╠══════════════════════════╣\n"+
"║ "+abLine+"\n"+
"╠══════════════════════════╣\n"+
"║ ⚡ BET ON: "+signal.val+"\n"+
"╚══════════════════════════╝",
        {reply_markup:{inline_keyboard:[[{text:"💰 GOAOKO PLAY NOW",url:REG_LINK}]]}}
    );

    if(cfg.enabled&&shouldBetNow(userId)){
        const result=await placeBet(userId,chatId,next,signal.val,signal.type,st.level);
        if(result&&result.ok) await send(chatId,"✅ Bet Placed!\n"+result.bc+" ₹"+result.amt+" L"+st.level+"\n⏳ Result checking...");
    }
    checkResult(userId,chatId,next,signal.val,signal.type);
}

// ============================================================
//  RESULT CHECKER
// ============================================================
async function checkResult(userId, chatId, target, predicted, predType) {
    let tries=0;
    const cfg=autobetCfg[userId],st=autobetState[userId];
    const wasReal=cfg.enabled&&shouldBetNow(userId);
    const iv=setInterval(async()=>{
        if(!running[userId])return clearInterval(iv);
        if(++tries>18){clearInterval(iv);await send(chatId,"⏱ Timeout");setTimeout(()=>{if(running[userId])runPredict(userId,chatId);},3000);return;}
        const list=await fetchList();if(!list)return;
        if(BigInt(list[0].issueNumber)<BigInt(target))return;
        clearInterval(iv);
        const res=list.find(i=>i.issueNumber===target)||list[0];
        const num=parseInt(res.number);
        let actual;
        if(predType==="SIZE")actual=num>=5?"BIG":"SMALL";
        else actual=num===0?"RED":num===5?"GREEN":num%2===0?"RED":"GREEN";
        const win=predicted===actual;
        const s=stats[userId];
        s.total++;
        if(win){s.win++;s.winStreak++;s.lossStreak=0;if(s.winStreak>s.maxWinStreak)s.maxWinStreak=s.winStreak;}
        else{s.loss++;s.lossStreak++;s.winStreak=0;if(s.lossStreak>s.maxLossStreak)s.maxLossStreak=s.lossStreak;}

        if(cfg.enabled){
            if(wasReal){
                if(win)await handleWin(userId,chatId,actual,num);
                else   await handleLoss(userId,chatId,actual,num);
            } else {
                if(!win){
                    st.consecutiveLoss++;
                    const need=cfg.watchLoss-st.consecutiveLoss;
                    await send(chatId,"👀 Watch Loss: "+st.consecutiveLoss+"/"+cfg.watchLoss+"\n"+(need>0?"⏳ "+need+" more needed...":"🚀 Real bet starts next signal!"));
                } else {
                    st.consecutiveLoss=0;
                    await send(chatId,"👀 Watch ✅ Correct! (virtual)\n🔄 Loss counter reset → 0/"+cfg.watchLoss);
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
    send(chatId,"╔══════════════════════════╗\n║  📊 STATS                ║\n╠══════════════════════════╣\n"+"║ Total  : "+d.total+"\n║ Wins   : "+d.win+"\n║ Losses : "+d.loss+"\n"+"║ Acc    : "+rate+"%\n║ "+bar+"\n╠══════════════════════════╣\n"+"║ Best Win  : "+d.maxWinStreak+" streak\n║ Worst Loss: "+d.maxLossStreak+" streak\n╚══════════════════════════╝");
}
function profitReport(chatId,userId){
    const pt=profitTrack[userId],cfg=autobetCfg[userId];
    const rate=pt.totalBets?((pt.wins/pt.totalBets)*100).toFixed(1):"0.0";
    const bar="🟦".repeat(pt.totalBets?Math.round(pt.wins/pt.totalBets*10):0)+"⬜".repeat(pt.totalBets?10-Math.round(pt.wins/pt.totalBets*10):10);
    const amounts=MULT.slice(0,cfg.maxLvl).map(m=>cfg.baseBet*m);
    send(chatId,"╔══════════════════════════╗\n║  💰 PROFIT REPORT        ║\n╠══════════════════════════╣\n"+"║ Bets   : "+pt.totalBets+"\n║ Wins   : "+pt.wins+"\n║ Losses : "+pt.losses+"\n"+"║ Rate   : "+rate+"%\n║ "+bar+"\n╠══════════════════════════╣\n"+"║ P&L    : "+(pt.pnl>=0?"+":"")+pt.pnl.toFixed(2)+"\n"+"║ Best W : "+pt.maxW+" streak\n║ Worst L: "+pt.maxL+" streak\n╠══════════════════════════╣\n"+"║ Mart   : ₹"+amounts.join("→₹")+"\n╚══════════════════════════╝");
}
function autobetStatus(chatId,userId){
    const cfg=autobetCfg[userId],st=autobetState[userId],pt=profitTrack[userId];
    const tok=getToken(userId);
    const creds=userCreds[userId]||{};
    const amounts=MULT.slice(0,cfg.maxLvl).map(m=>cfg.baseBet*m);
    send(chatId,
"╔══════════════════════════╗\n║  🤖 AUTOBET STATUS       ║\n╠══════════════════════════╣\n"+
"║ AutoBet   : "+(cfg.enabled?"✅ ON":"❌ OFF")+"\n"+
"║ Token     : "+(tok.length>20?"✅ SET":"❌ MISSING")+"\n"+
"║ AutoLogin : "+(creds.phone?"✅ "+creds.phone.slice(0,6)+"***":"❌ /setcreds")+"\n"+
"║ Watch     : "+(cfg.watch?"ON":"OFF")+"\n"+
"║ WatchLoss : "+st.consecutiveLoss+"/"+cfg.watchLoss+"\n"+
"║ Base Bet  : ₹"+cfg.baseBet+"\n"+
"║ Max Level : "+cfg.maxLvl+"\n"+
"╠══════════════════════════╣\n"+
"║ Mart Lvl  : L"+st.level+"\n"+
"║ In Mart   : "+(st.inMart?"YES":"NO")+"\n"+
"║ P&L       : "+(pt.pnl>=0?"+":"")+pt.pnl.toFixed(2)+"\n"+
"╠══════════════════════════╣\n"+
"║ ₹"+amounts.join("→₹")+"\n╚══════════════════════════╝"
    );
}

// ============================================================
//  KEYBOARDS
// ============================================================
function userMenu(id){
    const rows=[["▶️ Start Prediction","🛑 Stop"],["📊 Stats","💰 Profit","📩 Contact"],["🤖 AutoBet Setup","🔑 My Token"]];
    if(isAdmin(id))rows.push(["👑 Admin Panel"]);
    return{keyboard:rows,resize_keyboard:true};
}
const ownerMenu={keyboard:[["👥 All Users","👮 All Admins"],["👤 Add Admin","🗑 Remove Admin"],["🔑 Generate Key","📋 All Keys"],["🟢 Add User","🔴 Remove User"],["🔐 Set Token","📊 All Stats"],["🚪 Owner Logout"]],resize_keyboard:true};
const adminMenu={keyboard:[["👥 Active Users","🔑 Generate Key"],["🟢 Add User","🔴 Remove User"],["📋 All Keys","🚪 Admin Logout"]],resize_keyboard:true};
const autobetMenu={keyboard:[["✅ Enable AutoBet","❌ Disable AutoBet"],["👀 Watch Mode ON","👀 Watch Mode OFF"],["💰 Set Base Bet","📈 Set Max Level"],["🔢 Set Watch Losses","📊 AutoBet Status"],["🔙 Back"]],resize_keyboard:true};

// ============================================================
//  BOT INIT
// ============================================================
let bot;
function startBot(){
    if(bot){try{bot.stopPolling();}catch(e){}}
    bot=new TelegramBot(BOT_TOKEN,{polling:{interval:1000,autoStart:true,params:{timeout:30}}});
    bot.on("polling_error",err=>{console.error("Poll:",err.message);setTimeout(startBot,5000);});
    bot.on("error",err=>{console.error("Bot:",err.message);});
    addHandlers();
    console.log("✅ SIVA BOT running...");
}
async function send(chatId,text,opts={}){
    try{return await bot.sendMessage(chatId,text,opts);}
    catch(e){if(e.message&&e.message.includes("parse entities")){try{const o={...opts};delete o.parse_mode;return await bot.sendMessage(chatId,text,o);}catch(e2){}}console.error("send:",e.message?.substr(0,60));}
}
async function sendSticker(chatId,sid){try{await bot.sendSticker(chatId,sid);}catch(e){}}

// ============================================================
//  HANDLERS
// ============================================================
function addHandlers(){

    bot.onText(/\/start/,(msg)=>{
        const id=msg.from.id;initUser(id);
        const status=hasAccess(id)?"✅ ACTIVE — "+daysLeft(id)+"d left":"❌ NO ACCESS";
        send(msg.chat.id,
"╔══════════════════════════╗\n║  👑 SIVA ULTRA AI BOT    ║\n╠══════════════════════════╣\n"+
"║ Status : "+status+"\n║ ID     : "+id+"\n║ Admin  : "+ADMIN_HANDLE+"\n╠══════════════════════════╣\n"+
"║ 🔑 /key CODE to activate ║\n╚══════════════════════════╝",
        {reply_markup:userMenu(id)});
    });

    bot.onText(/\/key (.+)/,(msg,match)=>{
        const id=msg.from.id;initUser(id);
        const res=activateKey(id,match[1].trim());
        if(res.ok){send(msg.chat.id,"🎊 KEY ACTIVATED!\n⏳ "+res.days+" days\n📅 "+res.expiry,{reply_markup:userMenu(id)});send(OWNER_ID,"🔔 Key used!\nUser: "+id+"\nDays: "+res.days);}
        else send(msg.chat.id,res.msg);
    });

    // FIXED: /setcreds FULLPHONE PASSWORD
    // phone = country code + number (e.g. 916381605525)
    bot.onText(/\/setcreds (.+)/,(msg,match)=>{
        const id=msg.from.id;
        if(!hasAccess(id))return send(id,"❌ No access.");
        const parts=match[1].trim().split(/\s+/);
        if(parts.length<2)return send(id,
"❌ Format:\n/setcreds FULLPHONE PASSWORD\n\n"+
"Example (India +91):\n/setcreds 916381605525 mypassword\n\n"+
"Phone = CountryCode + Number\n"+
"India 91 + 6381605525 = 916381605525"
        );
        const phone=parts[0], pass=parts.slice(1).join(" ");
        if(!userCreds[id])userCreds[id]={};
        userCreds[id].phone=phone;
        userCreds[id].pass=pass;
        send(id,"✅ Credentials saved!\n📱 "+phone+"\n\n🔄 Testing login...");
        autoLogin(id,msg.chat.id,false);
    });

    bot.onText(/\/setmytoken (.+)/,(msg,match)=>{
        const id=msg.from.id;
        if(!hasAccess(id))return send(id,"❌ No access.");
        const tok=match[1].trim().replace(/^Bearer\s+/i,"");
        if(tok.length<20)return send(id,"❌ Token too short!");
        userTokens[id]=tok;
        send(id,"✅ Token saved!\n..."+tok.slice(-12)+"\n\n🤖 AutoBet Setup → ✅ Enable AutoBet");
    });

    bot.onText(/\/login/,(msg)=>{
        const id=msg.from.id;
        if(!hasAccess(id))return send(id,"❌ No access.");
        send(id,"🔄 Logging in...");
        autoLogin(id,msg.chat.id,false);
    });

    bot.onText(/\/owner/,(msg)=>{
        if(msg.from.id!==OWNER_ID)return;
        if(ownerLoggedIn)return send(OWNER_ID,"Already in!",{reply_markup:ownerMenu});
        ownerState={action:"login"};send(OWNER_ID,"🔐 Owner password:");
    });

    bot.onText(/\/adminlogin (.+)/,(msg,match)=>{
        const id=msg.from.id,pass=match[1].trim();
        if(!isAdmin(id))return send(id,"Not admin.");
        if(pass===adminPasswords[id]){adminLoggedIn[id]=true;send(id,"✅ Admin Login!",{reply_markup:userMenu(id)});}
        else send(id,"❌ Wrong!");
    });

    bot.on("message",async msg=>{
        const id=msg.from.id,text=msg.text;
        if(!text||text.startsWith("/"))return;
        initUser(id);

        const OB=["👥 All Users","👮 All Admins","👤 Add Admin","🗑 Remove Admin","🔑 Generate Key","📋 All Keys","🟢 Add User","🔴 Remove User","🔐 Set Token","📊 All Stats","🚪 Owner Logout"];
        const AB=["👥 Active Users","🔑 Generate Key","🟢 Add User","🔴 Remove User","📋 All Keys","🚪 Admin Logout"];

        // OWNER STATE
        if(id===OWNER_ID&&ownerState){
            const s=ownerState;
            if(s.action==="login"){if(text===OWNER_PASS){ownerLoggedIn=true;ownerState=null;return send(OWNER_ID,"👑 Welcome Boss!",{reply_markup:ownerMenu});}else return send(OWNER_ID,"❌ Wrong!");}
            if(OB.includes(text)){ownerState=null;}
            else if(s.action==="addadmin"){if(!s.step2){const t=parseInt(text);if(isNaN(t))return send(OWNER_ID,"❌ Invalid");ownerState={action:"addadmin",step2:true,tid:t};return send(OWNER_ID,"ID:"+t+"\nPassword:");}else{if(text.length<6)return send(OWNER_ID,"❌ Min 6 chars");adminPasswords[s.tid]=text;adminLoggedIn[s.tid]=false;ownerState=null;send(OWNER_ID,"✅ Admin: "+s.tid,{reply_markup:ownerMenu});send(s.tid,"🎉 Admin!\n/adminlogin "+text);return;}}
            else if(s.action==="removeadmin"){const t=parseInt(text);if(isNaN(t))return;delete adminPasswords[t];delete adminLoggedIn[t];ownerState=null;send(OWNER_ID,"🚫 "+t+" removed",{reply_markup:ownerMenu});return;}
            else if(s.action==="genkey"){const d=parseInt(text);if(isNaN(d)||d<1)return send(OWNER_ID,"❌ Days?");const k=generateKey(d,OWNER_ID);ownerState=null;return send(OWNER_ID,"🔑 Key:\n\n"+k+"\n\n"+d+"d\nUser: /key "+k,{reply_markup:ownerMenu});}
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
            if(text==="🔴 Remove User")  {ownerState={action:"removeuser"};return send(OWNER_ID,"User ID?");}
            if(text==="🔐 Set Token")    {ownerState={action:"settoken"};return send(OWNER_ID,"Token paste:");}
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
            else if(s.action==="setbase"){const v=parseInt(text);if(isNaN(v)||v<1)return send(id,"❌ Min 1");autobetCfg[id].baseBet=v;delete adminState[id];const a=MULT.slice(0,autobetCfg[id].maxLvl).map(m=>v*m);return send(id,"✅ Base Bet: ₹"+v+"\nMart: ₹"+a.join("→₹"),{reply_markup:autobetMenu});}
            else if(s.action==="setlvl"){const v=parseInt(text);if(isNaN(v)||v<1||v>10)return send(id,"❌ 1-10 only");autobetCfg[id].maxLvl=v;delete adminState[id];const a=MULT.slice(0,v).map(m=>autobetCfg[id].baseBet*m);return send(id,"✅ Max Level: "+v+"\nMart: ₹"+a.join("→₹"),{reply_markup:autobetMenu});}
            else if(s.action==="setwloss"){const v=parseInt(text);if(isNaN(v)||v<1)return send(id,"❌ Min 1");autobetCfg[id].watchLoss=v;delete adminState[id];return send(id,"✅ Watch Losses: "+v+"\n"+v+" consecutive losses → real bet",{reply_markup:autobetMenu});}
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
            if(!isAdminIn(id))return send(id,"Login:\n/adminlogin YOUR_PASS");
            return send(id,"👑 Admin",{reply_markup:adminMenu});
        }

        // AUTOBET SETUP
        if(text==="🤖 AutoBet Setup"){
            if(!hasAccess(id))return send(id,"❌ No access.");
            const cfg=autobetCfg[id],creds=userCreds[id]||{};
            const amounts=MULT.slice(0,cfg.maxLvl).map(m=>cfg.baseBet*m);
            return send(id,
"🤖 AUTOBET SETTINGS\n\n"+
"Status    : "+(cfg.enabled?"✅ ON":"❌ OFF")+"\n"+
"Token     : "+(getToken(id).length>20?"✅ SET":"❌ MISSING")+"\n"+
"AutoLogin : "+(creds.phone?"✅ "+creds.phone.slice(0,6)+"***":"❌ /setcreds")+"\n\n"+
"Watch Mode: "+(cfg.watch?"ON":"OFF")+"\n"+
"Watch Loss: "+cfg.watchLoss+" consecutive\n"+
"Base Bet  : ₹"+cfg.baseBet+"\n"+
"Max Level : "+cfg.maxLvl+"\n\n"+
"Mart: ₹"+amounts.join("→₹")+"\n\n"+
"Setup:\n"+
"/setcreds 916381605525 PASSWORD\n"+
"/setmytoken TOKEN",
            {reply_markup:autobetMenu});
        }

        if(text==="✅ Enable AutoBet"){
            const creds=userCreds[id]||{};
            if(!getToken(id)&&!creds.phone)return send(id,"❌ /setcreds FULLPHONE PASSWORD\nor\n/setmytoken TOKEN");
            autobetCfg[id].enabled=true;
            if(!getToken(id)&&creds.phone){
                send(id,"🔄 Auto login...");
                const ok=await autoLogin(id,msg.chat.id,true);
                if(ok)send(id,"✅ AutoBet ON!\n💰 ₹"+autobetCfg[id].baseBet+" | Watch:"+(autobetCfg[id].watch?autobetCfg[id].watchLoss+"L":"OFF"),{reply_markup:userMenu(id)});
                else send(id,"⚠️ Login fail. /setcreds பண்ணு.",{reply_markup:autobetMenu});
            } else {
                send(id,"✅ AutoBet ON!\n💰 ₹"+autobetCfg[id].baseBet+" | Watch:"+(autobetCfg[id].watch?autobetCfg[id].watchLoss+"L":"OFF"),{reply_markup:userMenu(id)});
            }
            return;
        }
        if(text==="❌ Disable AutoBet"){autobetCfg[id].enabled=false;return send(id,"❌ AutoBet OFF",{reply_markup:userMenu(id)});}
        if(text==="👀 Watch Mode ON") {autobetCfg[id].watch=true;return send(id,"👀 Watch ON — "+autobetCfg[id].watchLoss+" consecutive losses → bet");}
        if(text==="👀 Watch Mode OFF"){autobetCfg[id].watch=false;return send(id,"👀 Watch OFF — Direct bet!");}
        if(text==="💰 Set Base Bet"){
            adminState[id]={action:"setbase"};
            const a=MULT.slice(0,autobetCfg[id].maxLvl).map(m=>autobetCfg[id].baseBet*m);
            return send(id,"Base bet (₹)?\nCurrent: ₹"+autobetCfg[id].baseBet+"\nMart: ₹"+a.join("→₹")+"\n\nEnter amount:");
        }
        if(text==="📈 Set Max Level"){
            adminState[id]={action:"setlvl"};
            const a=MULT.slice(0,10).map(m=>autobetCfg[id].baseBet*m);
            return send(id,"Max Level (1-10)?\nCurrent: "+autobetCfg[id].maxLvl+"\n\n"+a.map((v,i)=>"L"+(i+1)+": ₹"+v).join("\n")+"\n\nEnter level:");
        }
        if(text==="🔢 Set Watch Losses"){
            adminState[id]={action:"setwloss"};
            return send(id,"Watch losses?\nCurrent: "+autobetCfg[id].watchLoss+"\n\nExample: 2\n→ 2 consecutive losses → L1 bet\n→ Win → reset, watch again\n\nEnter number:");
        }
        if(text==="📊 AutoBet Status")return autobetStatus(msg.chat.id,id);
        if(text==="🔙 Back")return send(id,"Main Menu",{reply_markup:userMenu(id)});

        if(text==="🔑 My Token"){
            const tok=getToken(id),creds=userCreds[id]||{};
            return send(id,
"Token: "+(tok.length>20?"✅ ..."+tok.slice(-12):"❌ Not set")+"\n"+
"Login : "+(creds.phone?"✅ "+creds.phone.slice(0,6)+"***":"❌ Not set")+"\n\n"+
"/setcreds FULLPHONE PASSWORD\n"+
"/setmytoken TOKEN\n"+
"/login — Test login"
            );
        }

        if(text==="▶️ Start Prediction"){
            if(!hasAccess(id))return send(msg.chat.id,"❌ No access!\n📩 "+ADMIN_HANDLE+"\n🆔 ID: "+id);
            if(running[id])return send(msg.chat.id,"⚠️ Already running!");
            if(!getToken(id)&&userCreds[id]?.phone){
                await send(msg.chat.id,"🔄 Auto login...");
                await autoLogin(id,msg.chat.id,true);
            }
            running[id]=true;sentPeriods[id]=new Set();
            autobetState[id]={level:1,consecutiveLoss:0,inMart:false};
            const cfg=autobetCfg[id];
            await send(msg.chat.id,
"🚀 ENGINE ON!\n\n"+
"AutoBet : "+(cfg.enabled?"✅ ON":"❌ OFF")+"\n"+
"Watch   : "+(cfg.watch?"ON ("+cfg.watchLoss+" consecutive losses)":"OFF")+"\n"+
"Base Bet: ₹"+cfg.baseBet+" | Max Level: "+cfg.maxLvl
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
