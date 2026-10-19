import assert from "node:assert/strict";
import { responseLanguageMatches } from "../api/index.js";

const api = "https://alice-ai-assistant-nine.vercel.app/api";
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));

async function request(command, session = {}) {
  const start=Date.now();
  const response=await fetch(api,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({version:"1.0",session:{new:false,message_id:1,session_id:"test"},user:{user_id:"ci-smoke"},request:{command,original_utterance:command,type:"SimpleUtterance"},state:{session}}),
    signal:AbortSignal.timeout(6500)
  });
  const data=await response.json();
  const text=String(data?.response?.text||"");
  console.log("Reply time:",Date.now()-start,"ms. Reply:",text.slice(0,900));
  console.log("State:",JSON.stringify({history:data?.session_state?.history?.length,sources:data?.session_state?.lastSearch?.sources?.length,pending:!!data?.session_state?.pendingSearch}));
  assert.equal(response.status,200);
  assert.equal(data.version,"1.0");
  assert.ok(text.length>0);
  assert.ok(responseLanguageMatches(command==="продолжай"?"Найди цену бензина":command,text),"Wrong language in Alice response");
  assert.doesNotMatch(text,/16[.,]25\s*(?:gel|лари)/i,"Hallucinated 16.25 GEL fuel price");
  return data;
}

async function waitForDeployment() {
  for (let i=0;i<34;i++) {
    try {
      const response=await fetch(api,{signal:AbortSignal.timeout(5000)});
      const data=await response.json();
      if (response.ok && data.version==="two-stage-search-1") {
        console.log("Updated production webhook is available:",data.version);
        return;
      }
      console.log("Still waiting for production:",response.status,data.version||"old");
    } catch(error) { console.log("Waiting for webhook:",error.name); }
    await sleep(3500);
  }
  throw new Error("New version was not seen at production URL");
}

await waitForDeployment();
console.log("CHECK 1: ordinary conversation");
const normal=await request("Сколько будет два плюс два?");
assert.doesNotMatch(normal.response.text,/Не получилось|не удалось|повтори|попробуй/i,"Chat completion failure");

console.log("CHECK 2: real fuel price search");
const query="Найди в интернете, сколько сейчас стоит бензин АИ-95 в Грузии, в лари за литр.";
const first=await request(query);
assert.ok(first.session_state?.lastSearch?.sources?.length,"Serper did not return saved sources");
let finished=first;
if (first.session_state?.pendingSearch) {
  console.log("CHECK 3: continue without another web search");
  finished=await request("продолжай",first.session_state);
}
console.log("CHECK 4: source citation");
const cited=await request("Пришли источник информации.",finished.session_state);
assert.match(cited.response.text,/https:\/\//,"Source follow-up did not contain a URL");
console.log("LIVE SMOKE COMPLETED, final price answer:",finished.response.text);
