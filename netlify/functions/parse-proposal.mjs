// netlify/functions/parse-proposal.mjs
const MODEL = "gemini-3.5-flash";

const SCHEMA = {
  type: "object",
  properties: {
    insurer:        { type: "string",  description: "보험사명 (예: DB손해보험, 한화손보, NH농협손보, 메리츠화재)" },
    productName:    { type: "string",  description: "상품명" },
    monthlyPremium: { type: "integer", description: "월 보장보험료(원)" },
    payYears:       { type: "integer", description: "납입 년수" },
    term:           { type: "string",  description: "보장만기 (예: 100세만기)" },
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
  required: ["insurer", "covs"]
};

const PROMPT = `이 PDF는 한국 손해보험 '가입제안서'입니다. 담보(보장) 목록 표에서 각 담보명과 가입금액을 정확히 추출하세요.
규칙:
- 가입금액은 반드시 '만원' 단위 정수로 변환: 1억원=10000, 5천만원=5000, 5백만원=500, 1천만원=1000, 2천만원=2000, 10만원=10, "101,135만원"=101135.
- '보험료납입면제대상', '보험료납입지원' 같은 행정성 담보는 제외.
- 소계/합계 행은 제외. 담보명 앞 '(건강고지)'·'(간편고지)'·순번은 제거하되 '116대질병'처럼 숫자가 담보명 일부면 보존.
- 같은 담보가 여러 줄(소계)로 나뉘면 대표(총액) 한 줄만.
- 보험사명·상품명·월 보장보험료(원)·납입년수·보장만기도 함께 추출.
오직 JSON으로만 응답.`;

export default async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  if (!process.env.GEMINI_API_KEY)
    return new Response(JSON.stringify({ error: "GEMINI_API_KEY 미설정" }), { status: 500 });

  let pdfBase64;
  try { ({ pdfBase64 } = await req.json()); } catch { return new Response("Bad Request", { status: 400 }); }
  if (!pdfBase64) return new Response(JSON.stringify({ error: "pdfBase64 누락" }), { status: 400 });

  const body = {
    contents: [{ parts: [
      { inline_data: { mime_type: "application/pdf", data: pdfBase64 } },
      { text: PROMPT }
    ]}],
    generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0 }
  };

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      { method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        body: JSON.stringify(body) }
    );
    if (!r.ok) {
      const t = await r.text();
      return new Response(JSON.stringify({ error: "Gemini 호출 실패", detail: t }), { status: 502 });
    }
    const data = await r.json();
    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "{}";
    const clean = text.replace(/```json|```/g, "").trim();
    return new Response(clean, { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
};
