import test from "node:test";
import assert from "node:assert/strict";
import { aliceResponse, fitAliceText, isSearchIntent, safeHistory, userLanguage, numericPriceIsGrounded, isSourceFollowup, responseLanguageMatches, compactSessionState } from "../api/index.js";

test("Alice response uses required response envelope", () => {
  const result = aliceResponse("Привет", false, [{ role: "user", text: "тест" }]);
  assert.equal(result.version, "1.0");
  assert.equal(result.response.text, "Привет");
  assert.equal(result.response.end_session, false);
  assert.deepEqual(result.session_state.history, [{ role: "user", text: "тест" }]);
});

test("search intent detects Russian and English freshness requests", () => {
  assert.equal(isSearchIntent("Какая погода сегодня?"), true);
  assert.equal(isSearchIntent("What is the latest news?"), true);
  assert.equal(isSearchIntent("Расскажи сказку"), false);
});

test("long responses are cut at a natural boundary and stay within Alice limit", () => {
  const value = fitAliceText(("Это короткое предложение. ").repeat(100));
  assert.ok(value.length <= 1024);
  assert.ok(value.endsWith("."));
});

test("history filters malformed messages and keeps last 12", () => {
  const input = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "model" : "user", text: String(i) }));
  input.push({ role: "hacker", text: "ignore" }, { role: "user", text: 17 });
  const result = safeHistory(input);
  assert.equal(result.length, 12);
  assert.equal(result[0].text, "0");
  assert.equal(result[11].text, "11");
});

test("GET health check returns an ok response", async () => {
  const handler = (await import("../api/index.js")).default;
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "GET" }, res);
  assert.equal(statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.service, "alice-openai-serper");
});

test("launch request returns a valid Alice greeting without external API keys", async () => {
  const handler = (await import("../api/index.js")).default;
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method: "POST", body: { request: { command: "" }, state: { session: { history: [] } } } }, res);
  assert.equal(statusCode, 200);
  assert.equal(payload.version, "1.0");
  assert.match(payload.response.text, /Привет/);
  assert.equal(payload.response.end_session, false);
});

test("missing OpenAI key produces safe Alice response", async () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const handler = (await import("../api/index.js")).default;
    let payload;
    const res = {
      status() { return this; },
      json(value) { payload = value; return value; },
      setHeader() {}
    };
    await handler({ method: "POST", body: { request: { command: "Привет" } } }, res);
    assert.equal(payload.version, "1.0");
    assert.match(payload.response.text, /OPENAI_API_KEY/);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test("respond in the user's language", () => {
  assert.equal(userLanguage("Сколько сейчас стоит бензин АИ-95 в Грузии?"), "ru");
  assert.equal(userLanguage("Search online for gas prices in Georgia"), "en");
});

test("source follow-up is not mistaken for a fresh web query", () => {
  assert.equal(isSourceFollowup("Пришли источник информации"), true);
  assert.equal(isSourceFollowup("Найди бензин в Грузии"), false);
});

test("unverified fuel price 16.25 GEL is rejected", () => {
  const search = { sources: [{
    link: "https://example.ge/prices",
    title: "Gas prices",
    snippet: "АИ-95 стоит 3,95 лари за литр"
  }] };
  assert.equal(numericPriceIsGrounded("Цена 16,25 лари за литр", search), false);
  assert.equal(numericPriceIsGrounded("Цена 3,95 лари за литр", search), true);
});

test("numeric substrings and currency-free snippets cannot validate prices", () => {
  const search = { sources: [{link:"https://example.ge",snippet:"Показатель 316,25 и 16,25 километра"}] };
  assert.equal(numericPriceIsGrounded("16,25 лари", search), false);
  assert.equal(numericPriceIsGrounded("16,25 лари", {sources:[]}), false);
});

test("reject an English-dominant answer for a Russian question", () => {
  assert.equal(responseLanguageMatches("Сколько стоит бензин в Грузии?", "The gasoline price is sixteen lari and I think that might be current."),false);
  assert.equal(responseLanguageMatches("Сколько стоит бензин в Грузии?", "По информации найденного сайта, цена составляет около четырёх лари."),true);
  assert.equal(responseLanguageMatches("What is the fuel price in Georgia?", "I couldn't confirm the latest price."),true);
});

test("recognize GEL amount before and after the number", () => {
  const source={sources:[{link:"https://gulf.ge/prices",title:"Premium 95 in Georgia",snippet:"Premium 95: ₾ 3.95 per litre"}],query:"Сколько стоит бензин АИ-95 в Грузии?"};
  assert.equal(numericPriceIsGrounded("Цена 3,95 лари за литр",source),true);
  assert.equal(numericPriceIsGrounded("Цена 16,25 лари за литр",source),false);
});

test("Alice session state remains under 1KB even with long history and search sources", () => {
  const history = Array.from({length:12},(_,i)=>({role:i%2?"model":"user",text:"Продолжительное сообщение про Барсика и рыбку ".repeat(20)}));
  const search = {sources:Array.from({length:4},(_,i)=>({
    link:"https://example.ge/fuel-prices/very-long-premium-95-article",
    title:"Georgian gasoline and petrol stations daily rates from a long title ".repeat(4),
    snippet:"Стоимость топлива в Грузии сегодня ".repeat(20),
    date:"19 October 2026"
  })),answerSupported:false};
  const state = compactSessionState(history,search,{query:"Сколько сейчас стоит бензин АИ-95 в Грузии? " .repeat(8)});
  assert.ok(Buffer.byteLength(JSON.stringify(state),"utf8")<=1024);
  assert.ok(state.lastSearch.sources.length>=1);
  assert.ok(state.pendingSearch.query);
});

test("help command is local and does not require OpenAI credentials", async () => {
  const handler = (await import("../api/index.js")).default;
  let payload;
  await handler({method:"POST",body:{request:{command:"Что ты умеешь?"}}},{
    status(){return this},json(data){payload=data;return data},setHeader(){}
  });
  assert.match(payload.response.text,/могу/);
  assert.equal(payload.response.end_session,false);
});

test("Yandex ping has a fast response with a valid envelope", async () => {
  const handler=(await import("../api/index.js")).default;
  let payload;
  await handler({method:"POST",body:{request:{command:"",original_utterance:"ping"}}},{
    status(){return this},json(data){payload=data;return data},setHeader(){}
  });
  assert.equal(payload.version,"1.0");
  assert.equal(payload.response.text,"ok");
});

test("new skill presents itself as Умный Филин at launch", async () => {
  const handler = (await import("../api/index.js")).default;
  let result;
  await handler({method:"POST",body:{request:{command:""},state:{session:{history:[]}}}},{
    status(){return this;}, json(value){result=value;return value;}, setHeader(){}
  });
  assert.match(result.response.text,/Я Умный Филин/);
  assert.doesNotMatch(result.response.text,/Смарт Скилл/);
});

test("identity answer uses new name without calling OpenAI", async () => {
  const handler = (await import("../api/index.js")).default;
  let result;
  await handler({method:"POST",body:{request:{command:"Как тебя зовут?"},state:{session:{history:[]}}}},{
    status(){return this;}, json(value){result=value;return value;}, setHeader(){}
  });
  assert.match(result.response.text,/Я Умный Филин/);
  assert.equal(result.session_state.history.length,2);
});
