import test from "node:test";
import assert from "node:assert/strict";
import handler from "../api/index.js";

function callAlice(command, state = {}) {
  let payload;
  const res = {
    status() { return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  return Promise.resolve(handler({
    method:"POST",
    body:{request:{command},state:{session:state}}
  },res)).then(() => payload);
}

function webSearchResults() {
  return {
    organic:[{
      title:"Gulf Georgia Premium 95 current price",
      link:"https://gulf.ge/en/prices",
      snippet:"Premium 95 petrol in Georgia costs 3.95 GEL per litre",
      date:"Oct 19, 2026"
    }]
  };
}
function responseJson(data, ok = true, status = 200) {
  return {ok,status,json:async()=>data};
}

test("reject invented 16.25 GEL even when search finds a real source", async () => {
  const originalFetch=globalThis.fetch;
  const prevOpenAI=process.env.OPENAI_API_KEY;
  const prevSerper=process.env.SERPER_API_KEY;
  process.env.OPENAI_API_KEY="mock-openai";
  process.env.SERPER_API_KEY="mock-serper";
  let searchCalls=0;
  let modelCalls=0;
  try {
    globalThis.fetch=async url => {
      if (String(url).includes("serper.dev")) {
        searchCalls++;
        return responseJson(webSearchResults());
      }
      if (String(url).includes("api.openai.com")) {
        modelCalls++;
        return responseJson({output:[{content:[{type:"output_text",text:"Сейчас АИ-95 в Грузии стоит 16,25 лари за литр."}]}]});
      }
      throw new Error("Unexpected URL: "+url);
    };
    const first=await callAlice("Найди в интернете, сколько сейчас стоит бензин АИ-95 в Грузии, в лари за литр.");
    assert.equal(searchCalls,1);
    assert.equal(modelCalls,1);
    assert.doesNotMatch(first.response.text,/16[,.]25/);
    assert.match(first.response.text,/Не буду придумывать|не позволяют/i);
    assert.equal(first.session_state.lastSearch.answerSupported,false);
    const second=await callAlice("Это неправда. Пришли источник информации.",first.session_state);
    assert.match(second.response.text,/gulf\.ge/);
    assert.match(second.response.text,/не подтверждают/);
    assert.equal(searchCalls,1);
    assert.equal(modelCalls,1);
  } finally {
    globalThis.fetch=originalFetch;
    if (prevOpenAI===undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY=prevOpenAI;
    if (prevSerper===undefined) delete process.env.SERPER_API_KEY; else process.env.SERPER_API_KEY=prevSerper;
  }
});

test("slow model resumes from saved search data without second Serper request", async () => {
  const originalFetch=globalThis.fetch;
  const prevOpenAI=process.env.OPENAI_API_KEY;
  const prevSerper=process.env.SERPER_API_KEY;
  process.env.OPENAI_API_KEY="mock-openai";
  process.env.SERPER_API_KEY="mock-serper";
  let searchCalls=0;
  let modelCalls=0;
  try {
    globalThis.fetch=async url => {
      if (String(url).includes("serper.dev")) {
        searchCalls++;
        return responseJson(webSearchResults());
      }
      if (String(url).includes("api.openai.com")) {
        modelCalls++;
        if (modelCalls===1) {
          const error=new Error("Model request aborted");
          error.name="AbortError";
          throw error;
        }
        return responseJson({output:[{content:[{type:"output_text",text:"По данным Gulf Georgia, бензин АИ-95 стоит 3,95 лари за литр."}]}]});
      }
      throw new Error("Unexpected URL: "+url);
    };
    const first=await callAlice("Найди в интернете цену бензина АИ-95 в Грузии сегодня.");
    assert.match(first.response.text,/продолжай/);
    assert.equal(first.session_state.pendingSearch.query.includes("бензина"),true);
    const second=await callAlice("продолжай",first.session_state);
    assert.match(second.response.text,/3,95/);
    assert.doesNotMatch(second.response.text,/продолжай/);
    assert.equal(searchCalls,1);
    assert.equal(modelCalls,2);
    assert.equal(second.session_state.pendingSearch,undefined);
  } finally {
    globalThis.fetch=originalFetch;
    if (prevOpenAI===undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY=prevOpenAI;
    if (prevSerper===undefined) delete process.env.SERPER_API_KEY; else process.env.SERPER_API_KEY=prevSerper;
  }
});

test("empty search does not invent a current price", async () => {
  const originalFetch=globalThis.fetch;
  const prevSerper=process.env.SERPER_API_KEY;
  process.env.SERPER_API_KEY="mock-serper";
  try {
    globalThis.fetch=async url => {
      assert.match(String(url),/serper\.dev/);
      return responseJson({organic:[]});
    };
    const result=await callAlice("Найди в интернете цену АИ-95 в Тбилиси сейчас.");
    assert.match(result.response.text,/Не удалось получить/);
    assert.equal(result.session_state.lastSearch,undefined);
  } finally {
    globalThis.fetch=originalFetch;
    if (prevSerper===undefined) delete process.env.SERPER_API_KEY; else process.env.SERPER_API_KEY=prevSerper;
  }
});
