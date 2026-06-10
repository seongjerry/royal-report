// netlify/functions/parse-proposal.mjs
// 보험 PDF(보장분석/가입현황 또는 가입제안서)를 받아 계약·담보를 구조화 추출.
// GEMINI_API_KEY 는 Netlify 환경변수에만 둡니다(HTML 노출 금지).

// 키가 접근 가능한 모델을 순서대로 시도 (앞이 실패/미지원이면 다음으로 자동 폴백)
const MODELS = ["gemini-3.5-flash", "gemini-2.5-flash", "gemini-2.0-flash"];

const SCHEMA = {
  type: "object",
  properties: {
    documentType: { type: "string", description: "analysis(보장분석/가입현황·기존계약 여러건) 또는 proposal(가입제안서·신규)" },
    customer: {
      type: "object",
      properties: { name: { type: "string" }, cert: { type: "string", description: "생년월일/증권 식별 일부" } }
    },
    contracts: {
      type: "array",
      description: "계약(또는 제안 상품) 목록. 보장분석이면 보유계약 전부, 제안서면 1건.",
      items: {
        type: "object",
        properties: {
          insurer:        { type: "string",  description: "보험사명 (예: DB손해보험, 한화손보, NH농협손보, 메리츠화재, 롯데손해보험)" },
          product:        { type: "string",  description: "상품명" },
          monthlyPremium: { type: "integer", description: "월 보험료(원)" },
          totalPremium:   { type: "integer", description: "총 납입보험료(원), 없으면 0" },
          contractDate:   { type: "string",  description: "계약일 YYYY.MM.DD, 제안서면 빈 문자열" },
          payYears:       { type: "integer", description: "납입 년수" },
          term:           { type: "string",  description: "보장만기 (예: 100세만기, 종신)" },
          covs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string",  description: "담보명" },
                amt:  { type: "integer", description: "가입금액(만원 단위 정수)" }
              },
              required: ["name", "amt"]
            }
          }
        },
        required: ["insurer", "product", "covs"]
      }
    }
  },
  required: ["documentType", "contracts"]
};

const PROMPT = `이 PDF는 한국 손해보험/생명보험 문서입니다. 두 종류 중 하나입니다.
(1) 보장분석·가입현황·증권요약: 고객이 이미 가입한 '여러 기존계약'이 나열됨 → documentType="analysis", contracts에 각 계약을 모두.
(2) 가입제안서: 새로 권유하는 '신규 상품 1건' → documentType="proposal", contracts에 1건.

각 계약/상품마다 추출:
- insurer(보험사명), product(상품명), monthlyPremium(월보험료 원), totalPremium(총납입 원, 없으면 0),
  contractDate(계약일, 제안서면 ""), payYears(납입년수 정수), term(보장만기 텍스트),
- covs: 담보(특약) 목록 [{name, amt}]

규칙:
- amt는 반드시 '만원' 단위 정수로 변환: 1억원=10000, 5천만원=5000, 5백만원=500, 1천만원=1000, 2천만원=2000, 10만원=10, "101,135만원"=101135.
- 가입금액이 '원' 단위로 적혀 있으면 만원으로 환산(10,000,000원=1000).
- '보험료납입면제대상', '보험료납입지원' 같은 행정성 담보는 제외.
- 소계/합계 행은 제외. 담보명 앞 '(건강고지)'·'(간편고지)'·순번은 제거하되 '116대질병'처럼 숫자가 담보명 일부면 보존.
- 같은 담보가 여러 줄(소계)로 나뉘면 대표(총액) 한 줄만.
- 보장분석 문서에서 계약별 담보가 별첨/상세 페이지에 있으면 그 페이지까지 읽어 계약에 매칭.
오직 스키마에 맞는 JSON으로만 응답.`;

async function callModel(model, pdfBase64, apiKey) {
  const body = {
    contents: [{ parts: [
      { inline_data: { mime_type: "application/pdf", data: pdfBase64 } },
      { text: PROMPT }
    ]}],
    generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0 }
  };
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    { method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(body) }
  );
  const txt = await r.text();
  return { ok: r.ok, status: r.status, txt };
}

export default async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return new Response(JSON.stringify({ error: "GEMINI_API_KEY 미설정" }), { status: 500 });

  let pdfBase64;
  try { ({ pdfBase64 } = await req.json()); } catch { return new Response("Bad Request", { status: 400 }); }
  if (!pdfBase64) return new Response(JSON.stringify({ error: "pdfBase64 누락" }), { status: 400 });

  let lastErr = "";
  for (const model of MODELS) {
    try {
      const { ok, status, txt } = await callModel(model, pdfBase64, apiKey);
      if (ok) {
        const data = JSON.parse(txt);
        const out = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "{}";
        return new Response(out.replace(/```json|```/g, "").trim(),
          { headers: { "Content-Type": "application/json", "x-model-used": model } });
      }
      lastErr = `[${model}] ${status} ${txt}`;
      if (!/not.?found|not supported|does not exist|PERMISSION|unavailable/i.test(txt)) break;
    } catch (e) { lastErr = `[${model}] ${String(e)}`; }
  }
  return new Response(JSON.stringify({ error: "Gemini 호출 실패", detail: lastErr }), { status: 502 });
};
