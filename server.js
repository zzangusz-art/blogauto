'use strict';

require('dotenv').config();
const express   = require('express');
const Database  = require('better-sqlite3');
const Anthropic = require('@anthropic-ai/sdk');
const path      = require('path');
const rateLimit = require('express-rate-limit');

const app  = express();
const PORT = process.env.PORT || 4000;

// ── DB ──────────────────────────────────────────────────
const db = new Database(process.env.DB_PATH || './blog.db');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    keywords    TEXT    NOT NULL,
    features    TEXT,
    tone        TEXT    NOT NULL,
    length      TEXT    NOT NULL,
    title       TEXT,
    content     TEXT    NOT NULL,
    model       TEXT    NOT NULL,
    tokens_in   INTEGER DEFAULT 0,
    tokens_out  INTEGER DEFAULT 0,
    created_at  INTEGER DEFAULT (strftime('%s','now'))
  )
`);

// category 컬럼 마이그레이션 (이미 존재하면 무시)
try { db.exec("ALTER TABLE posts ADD COLUMN category TEXT DEFAULT ''"); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS cardnews_posts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT,
    cards_json TEXT NOT NULL,
    tokens_in  INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  )
`);

// ── Anthropic ────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Middleware ───────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  message: { error: '1분에 최대 20회 요청 가능합니다. 잠시 후 다시 시도하세요.' }
});

// ── 프롬프트 헬퍼 ────────────────────────────────────────
const TONE_MAP = {
  '정보성': '유용한 정보를 명확하고 쉽게 전달하는 정보성 문체로. 수치·사실·팁을 적극 활용하세요.',
  '친근한': '독자와 대화하듯 편안하고 친근한 구어체로. 이모지는 사용하지 않습니다.',
  '전문적': '전문성과 신뢰를 드러내는 격식체로. 전문 용어를 적절히 사용하되 독자가 이해할 수 있게 설명하세요.',
  '감성적': '독자의 공감을 이끌어내는 따뜻하고 감성적인 문체로. 경험과 감정을 담아 서술하세요.',
  '후기성': '실제 수강생·합격자의 생생한 후기 형식으로. "처음엔 막막했다", "코칭 받고 나서 달라졌다" 같은 전후 변화를 중심으로, 구체적 에피소드와 감정의 흐름을 담아 신뢰감 있게 서술한다. 모든 문장은 ~했다, ~이었다, ~달라졌다, ~느꼈다 같은 평서문 종결 어미로 끝맺는다. ~합니다, ~해요, ~하세요 같은 경어체나 청유·명령형 어미는 사용하지 않는다.'
};

const LENGTH_MAP = {
  '짧게':  { desc: '600~900자 분량의 핵심만 담은 짧은 글로', sections: 2 },
  '보통':  { desc: '1200~1600자 분량의 충실한 글로',         sections: 3 },
  '길게':  { desc: '2000~2500자 분량의 깊이 있는 글로',       sections: 4 }
};

// ── 빅링커 6대 카테고리 ──────────────────────────────────
const CATEGORY_MAP = {
  '대입컨설팅': {
    label:  '대학 입시 생기부·수시&정시 면접 코칭 (고1~고3)',
    target: '고1~고3 학생 및 학부모',
    coreKw: '생기부, 학생부종합전형, 수시, 정시, 면접, 세부능력특기사항, 자기소개서, 대입 코칭',
    seo:    '제목에 "생기부", "수시", "합격"을 포함하고 학년별·전형별 키워드(학종, 교과, 정시)를 본문에 자연스럽게 반복합니다.',
    aeo:    '## 자주 묻는 질문 섹션을 추가하여 "생기부 관리 언제부터 해야 하나요?", "수시 vs 정시 어떤 전형이 유리한가요?", "면접에서 가장 많이 나오는 질문은?" 등에 직접 답변하는 Q&A 형식으로 작성합니다.',
    geo:    '학종·교과·정시 전형별 준비 단계를 번호 목록으로 구조화하고, 합격 가능 점수대·경쟁률 등 수치 정보를 포함하여 AI 검색이 인용하기 좋게 작성합니다.',
    extra:  '불안해하는 학부모와 학생 양쪽의 심리를 공감하되 실질적 해결책으로 신뢰를 주는 어조로 작성합니다.'
  },
  '편입컨설팅': {
    label:  '편입 코칭 (편입 영어·수학·논술)',
    target: '대학 재학생·졸업생, 편입 준비생',
    coreKw: '편입, 편입 영어, 편입 수학, 편입 논술, 학사 편입, 일반 편입, 편입 전형',
    seo:    '제목에 "편입" 키워드와 준비 기간·합격 전략·과목명을 포함합니다.',
    aeo:    '## 자주 묻는 질문에 "편입 준비 기간은 얼마나 필요한가요?", "편입 영어 어떻게 공부해야 하나요?", "편입 수학 범위가 어떻게 되나요?" 등을 Q&A 형식으로 작성합니다.',
    geo:    '학사 편입·일반 편입 유형 비교표, 시험 과목별 준비 전략·추천 교재를 단계별 목록으로 구조화합니다.',
    extra:  '현실적이고 실용적인 어조로 편입 준비생의 고민에 공감하고 구체적인 실행 계획을 제시합니다.'
  },
  '대학원컨설팅': {
    label:  '대학원 코칭 (자기소개서·학업계획서·면접)',
    target: '대학 졸업예정자, 직장인 대학원 진학 희망자',
    coreKw: '대학원, 자기소개서, 학업계획서, 연구계획서, 대학원 면접, 대학원 입시',
    seo:    '제목에 "대학원 자기소개서", "학업계획서 쓰는 법" 등 검색 빈도 높은 구문을 포함합니다.',
    aeo:    '## 자주 묻는 질문에 "대학원 자기소개서 어떻게 써야 하나요?", "직장인도 대학원 다닐 수 있나요?", "학업계획서와 연구계획서 차이는?" 등을 Q&A로 작성합니다.',
    geo:    '지원 서류 준비 단계(지원 동기·연구 주제·학업 계획 작성법)와 면접 준비 체크리스트를 목록 형식으로 구조화합니다.',
    extra:  '학문적 전문성과 현실 조언의 균형을 맞추며 진학을 고민하는 독자에게 용기를 주는 어조로 작성합니다.'
  },
  '취업컨설팅': {
    label:  '취업 코칭 (대기업·공기업·금융·병원·중견중소)',
    target: '취업 준비생, 이직 준비생',
    coreKw: '취업, 자기소개서, 면접, 대기업 취업, 공기업 시험, 금융권 취업, 병원 취업, NCS',
    seo:    '제목에 목표 기업군(대기업·공기업·금융·병원)과 "자소서", "면접 합격 전략"을 포함합니다.',
    aeo:    '## 자주 묻는 질문에 "자기소개서 어떻게 시작해야 하나요?", "면접에서 가장 중요한 것은?", "공기업 NCS 어떻게 준비하나요?" 등을 Q&A 형식으로 작성합니다.',
    geo:    '최신 채용 트렌드(AI 면접·블라인드 채용·직무 중심), 직무별 준비 로드맵과 핵심 스펙을 단계별 목록으로 구조화합니다.',
    extra:  '취준생의 불안과 도전을 공감하며 실용적인 팁과 동기부여를 균형 있게 제공합니다.'
  },
  '논문컨설팅': {
    label:  '논문 코칭',
    target: '대학원생, 연구자, 논문 작성 중인 학부생',
    coreKw: '논문 작성법, 학위논문, 논문 교정, 연구방법론, 통계분석, 논문 인용 방법',
    seo:    '제목에 "논문 작성법", "논문 교정" 등 검색 빈도 높은 구문을 포함합니다.',
    aeo:    '## 자주 묻는 질문에 "논문 서론 어떻게 시작하나요?", "논문 분량은 어느 정도 해야 하나요?", "통계 분석 어떤 방법을 써야 하나요?" 등을 Q&A로 작성합니다.',
    geo:    '논문 구조(서론→이론적 배경→연구방법→결과→결론·제언) 각 파트 작성법과 주의사항을 단계별 목록으로 구조화합니다.',
    extra:  '학문적 신뢰감을 유지하면서 복잡한 논문 작성 과정을 명확하고 단계적으로 안내하는 어조로 작성합니다.'
  },
  '기업교육컨설팅': {
    label:  '기업교육 코칭',
    target: '기업 HR·교육 담당자, 경영진, 팀장급 이상',
    coreKw: '기업교육, 임직원 교육, 직무교육, HRD, 조직 역량 강화, 기업 연수, 맞춤형 교육',
    seo:    '제목에 "기업교육", "임직원 역량 강화" 등을 포함하고 업종별·직급별 키워드를 활용합니다.',
    aeo:    '## 자주 묻는 질문에 "기업교육 효과는 어떻게 측정하나요?", "맞춤형 교육 프로그램 어떻게 구성하나요?", "외부 교육 vs 사내 교육 어떤 게 좋나요?" 등을 Q&A로 작성합니다.',
    geo:    '교육 유형(집합·온라인·블렌디드러닝), ROI 측정 방법, 최신 HRD 트렌드(마이크로러닝·AI 활용 교육)를 목록화하여 구조화합니다.',
    extra:  '비즈니스 성과와 ROI 관점에서 전문적으로 서술하고 의사결정자를 설득하는 논리적 어조로 작성합니다.'
  }
};

function buildPrompt(keywords, features, tone, length, category) {
  const toneGuide   = TONE_MAP[tone]   || TONE_MAP['정보성'];
  const lengthGuide = LENGTH_MAP[length] || LENGTH_MAP['보통'];
  const cat = CATEGORY_MAP[category] || null;

  const catBlock = cat
    ? `**카테고리:** ${cat.label}
**핵심 타겟:** ${cat.target}
**카테고리 핵심 키워드:** ${cat.coreKw}
**독자 공감 포인트:** ${cat.extra}`
    : '';

  const seoBlock = cat
    ? `\n9. **SEO:** ${cat.seo}\n10. **AEO(Answer Engine):** ${cat.aeo}\n11. **GEO(AI 검색 인용):** FAQ·비교 정보 섹션은 목록 허용, 로드맵·전략 섹션은 반드시 서술형 유지.`
    : '';

  return `다음 조건으로 블로그 글을 작성해주세요.

**키워드:** ${keywords}
${catBlock}
${features ? `**특징 및 요구사항:** ${features}` : ''}
**글투:** ${toneGuide}
**분량:** ${lengthGuide.desc} (본문 섹션 ${lengthGuide.sections}개)

---

### 필수 글 구조 — 아래 4단계를 반드시 이 순서로 구성하세요

**① 훅 + 공감 (Hook & Empathy)**
키워드와 카테고리에 맞는 독자의 현실적 어려움을 구체적으로 묘사하며 시작합니다.
"왜 이렇게 막막한지", "어디서부터 시작해야 할지 모르는 답답함",
"열심히 하는데 결과가 나오지 않는 좌절감"처럼
키워드에 딱 맞는 감정을 직접 건드려 독자가 "바로 나 얘기다"라고 느끼게 하세요.
특정 회사·기관·서비스명은 절대 언급하지 않습니다.

**② 숨겨진 진실 (Hidden Insider Truth)**
일반인이 잘 모르는, 실제로 합격·성공한 사람들만 아는 내부자 관점의 통찰을 담습니다.
예시:
- "대부분의 사람들은 이렇게 준비하지만, 실제 합격자들은 전혀 다른 전략을 씁니다"
- "흔히 이게 중요하다고 알려져 있지만, 현장에서 실제로 보면 그렇지 않습니다"
- "많은 사람들이 이 단계에서 시간을 낭비하는 이유가 있습니다"
통념을 뒤집는 인사이트, 현직자·합격자만 아는 사실, 대중에게 잘 알려지지 않은 정보를 제공합니다.
이 섹션이 글에서 가장 강력한 차별화 포인트입니다.

**③ 성공 로드맵·전략 (서술형 필수 — 단순 나열 절대 금지)**
합격·성공을 위한 전략을 인과관계와 흐름이 있는 서술형으로 씁니다.
"먼저 ~을 해야 합니다. 왜냐하면 ~이기 때문입니다. 그다음 ~으로 이어지는 이유는 ~입니다.
이 과정에서 많은 분들이 ~을 놓치는데, 사실 이 부분이 핵심입니다"처럼
각 단계의 이유·근거·연결고리를 함께 서술합니다.
·, -, 번호 목록으로 단순 나열하는 것은 이 섹션에서 절대 사용하지 않습니다.

**④ 요약 + 메타인지 실천 CTA**
글 전체의 핵심을 2~3문장으로 압축 요약합니다.
그다음, 독자가 스스로 자신의 현재 위치를 점검하고 오늘 당장 실천할 수 있는 구체적 행동을 제시합니다.
예시: "지금 이 글을 읽고 나서 당신이 가장 먼저 확인해야 할 것은 ~입니다",
"스스로에게 이 질문을 던져보세요: ~"처럼 메타인지를 유도하는 마무리로 끝냅니다.

---

### 작성 규칙
1. 마크다운 형식으로 작성합니다
2. 제목(#)은 하나만, 소제목은 ##을 사용합니다
3. **금지 단어(절대 사용 불가):** "빅링커", "컨설팅", "컨설턴트" — 이 단어들이 필요한 모든 문맥에서 "코칭", "코치"로 대체합니다. 특정 회사·플랫폼·서비스명도 언급하지 않습니다.
4. 키워드를 제목과 본문에 자연스럽게 반복 사용합니다
5. 로드맵·전략 섹션(③)은 반드시 서술형으로만 작성하며 단순 나열(·/-/번호)을 사용하지 않습니다
6. **줄바꿈(필수):** 본문 텍스트는 약 20자마다 어미(~습니다/~입니다/~에요/~요/~죠/~며/~고/~지만/~서/~면/~는데) 뒤에서 줄바꿈합니다. 한 줄이 25자를 넘지 않도록 합니다. 제목·FAQ 항목·표는 예외입니다.
7. ## 자주 묻는 질문 섹션은 키워드에 맞는 실제 궁금증 3개를 Q&A 형식으로 포함합니다
8. 글 맨 끝에 빈 줄 후 태그를 추가합니다: \`태그: #태그1 #태그2 #태그3 #태그4 #태그5\`${seoBlock}

지금 바로 블로그 글을 작성해주세요.`;
}

// ── Routes ───────────────────────────────────────────────

// POST /api/generate — 글 생성
app.post('/api/generate', apiLimiter, async (req, res) => {
  const { keywords, features = '', tone = '정보성', length = '보통', category = '' } = req.body;

  if (!keywords?.trim()) {
    return res.status(400).json({ error: '키워드는 필수입니다.' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY가 설정되지 않았습니다. .env 파일을 확인하세요.' });
  }

  try {
    const message = await anthropic.messages.create({
      model:      process.env.MODEL || 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: `당신은 교육 코칭 분야에 특화된 AEO·GEO·SEO 최적화 한국어 블로그 전문 작가입니다.
독자가 끝까지 읽고 싶어지는 매력적이고 신뢰감 있는 글을 마크다운 형식으로 씁니다.
다음 단어는 절대 사용하지 않습니다: "빅링커", "컨설팅", "컨설턴트". "코칭", "코치"로 대체합니다.
모든 글은 한국어로만 작성합니다.`,
      messages: [{ role: 'user', content: buildPrompt(keywords.trim(), features.trim(), tone, length, category.trim()) }]
    });

    const content    = message.content[0].text;
    const titleMatch = content.match(/^#\s+(.+)/m);
    const title      = titleMatch ? titleMatch[1].trim() : keywords.split(',')[0].trim();

    const row = db.prepare(`
      INSERT INTO posts (keywords, features, tone, length, category, title, content, model, tokens_in, tokens_out)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      keywords.trim(),
      features.trim() || null,
      tone, length,
      category.trim() || null,
      title, content,
      message.model,
      message.usage.input_tokens,
      message.usage.output_tokens
    );

    res.json({
      id:        row.lastInsertRowid,
      title,
      content,
      category:  category.trim() || null,
      model:     message.model,
      tokensIn:  message.usage.input_tokens,
      tokensOut: message.usage.output_tokens
    });

  } catch (err) {
    console.error('[generate]', err.message);
    if (err.status === 401) return res.status(401).json({ error: 'API 키가 유효하지 않습니다. .env의 ANTHROPIC_API_KEY를 확인하세요.' });
    if (err.status === 429) return res.status(429).json({ error: 'Claude API 요청 한도 초과. 잠시 후 다시 시도하세요.' });
    res.status(500).json({ error: `글 생성 실패: ${err.message}` });
  }
});

// GET /api/posts — 목록
app.get('/api/posts', (req, res) => {
  const posts = db.prepare(`
    SELECT id, keywords, features, tone, length, title, model, tokens_in, tokens_out, created_at
    FROM posts ORDER BY created_at DESC LIMIT 100
  `).all();
  res.json(posts);
});

// GET /api/posts/:id — 단건
app.get('/api/posts/:id', (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: '글을 찾을 수 없습니다.' });
  res.json(post);
});

// DELETE /api/posts/:id — 삭제
app.delete('/api/posts/:id', (req, res) => {
  const info = db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: '글을 찾을 수 없습니다.' });
  res.json({ success: true });
});

// ── 카드뉴스 이력 ───────────────────────────────────────
app.get('/api/cardnews', (req, res) => {
  const posts = db.prepare(
    'SELECT id, title, tokens_in, tokens_out, created_at FROM cardnews_posts ORDER BY created_at DESC LIMIT 100'
  ).all();
  res.json(posts);
});

app.get('/api/cardnews/:id', (req, res) => {
  const post = db.prepare('SELECT * FROM cardnews_posts WHERE id = ?').get(req.params.id);
  if (!post) return res.status(404).json({ error: '카드뉴스를 찾을 수 없습니다.' });
  try { post.cards = JSON.parse(post.cards_json); } catch {}
  res.json(post);
});

app.delete('/api/cardnews/:id', (req, res) => {
  const info = db.prepare('DELETE FROM cardnews_posts WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: '카드뉴스를 찾을 수 없습니다.' });
  res.json({ success: true });
});

// ── Unsplash 이미지 검색 프록시 ─────────────────────────
app.get('/api/unsplash', async (req, res) => {
  const q = (req.query.q || '').trim();
  console.log(`[unsplash] 요청: q="${q}"`);

  if (!q) return res.status(400).json({ error: '검색어가 필요합니다.' });

  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) {
    console.warn('[unsplash] API 키 없음 (UNSPLASH_ACCESS_KEY 환경변수 필요)');
    return res.json({ url: null });
  }

  try {
    const r = await fetch(
      `https://api.unsplash.com/photos/random?query=${encodeURIComponent(q)}&orientation=squarish&client_id=${key}`,
      { headers: { 'Accept-Version': 'v1' } }
    );
    if (!r.ok) {
      console.error(`[unsplash] API 오류: ${r.status}`);
      return res.json({ url: null });
    }
    const d = await r.json();
    const url = d.urls?.regular || d.urls?.small || null;
    console.log(`[unsplash] 응답: ${url ? '✓ URL 수신' : '✗ URL 없음'}`);
    res.json({ url });
  } catch (e) {
    console.error('[unsplash] 요청 실패:', e.message);
    res.json({ url: null });
  }
});

// ── 다량 생성 (SSE 스트리밍) ─────────────────────────────
const bulkLimiter = rateLimit({
  windowMs: 5 * 60_000,
  max: 5,
  message: { error: '5분에 최대 5회 다량 생성 가능합니다.' }
});

app.post('/api/generate/bulk', bulkLimiter, async (req, res) => {
  const { items, tone = '정보성', length = '보통', category = '' } = req.body;

  if (!Array.isArray(items) || !items.length)
    return res.status(400).json({ error: '생성할 항목이 없습니다.' });

  const valid = items.filter(it => it.keywords?.trim());
  if (!valid.length)
    return res.status(400).json({ error: '유효한 키워드가 없습니다.' });
  if (valid.length > 20)
    return res.status(400).json({ error: '한 번에 최대 20개까지 생성 가능합니다.' });
  if (!process.env.ANTHROPIC_API_KEY)
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY가 설정되지 않았습니다.' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let cancelled = false;
  req.on('close', () => { cancelled = true; });

  const send = (data) => {
    if (!res.writableEnded && !cancelled)
      res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  send({ type: 'start', total: valid.length });

  for (let i = 0; i < valid.length; i++) {
    if (cancelled) break;

    const { keywords, features = '' } = valid[i];
    send({ type: 'progress', index: i, keywords: keywords.trim() });

    try {
      const message = await anthropic.messages.create({
        model:      process.env.MODEL || 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: `당신은 교육 코칭 분야에 특화된 AEO·GEO·SEO 최적화 한국어 블로그 전문 작가입니다.
독자가 끝까지 읽고 싶어지는 매력적이고 신뢰감 있는 글을 마크다운 형식으로 씁니다.
다음 단어는 절대 사용하지 않습니다: "빅링커", "컨설팅", "컨설턴트". "코칭", "코치"로 대체합니다.
모든 글은 한국어로만 작성합니다.`,
        messages: [{ role: 'user', content: buildPrompt(keywords.trim(), features.trim(), tone, length, category.trim()) }]
      });

      const content    = message.content[0].text;
      const titleMatch = content.match(/^#\s+(.+)/m);
      const title      = titleMatch ? titleMatch[1].trim() : keywords.split(',')[0].trim();

      const row = db.prepare(`
        INSERT INTO posts (keywords, features, tone, length, category, title, content, model, tokens_in, tokens_out)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        keywords.trim(), features.trim() || null,
        tone, length, category.trim() || null,
        title, content,
        message.model,
        message.usage.input_tokens,
        message.usage.output_tokens
      );

      send({
        type: 'done', index: i,
        id: row.lastInsertRowid,
        title, content,
        keywords: keywords.trim(),
        tokensIn:  message.usage.input_tokens,
        tokensOut: message.usage.output_tokens
      });

    } catch (err) {
      console.error(`[bulk #${i}]`, err.message);
      send({ type: 'error', index: i, keywords: keywords.trim(), error: err.message });
    }

    if (i < valid.length - 1 && !cancelled)
      await new Promise(r => setTimeout(r, 800));
  }

  if (!cancelled) send({ type: 'complete' });
  res.end();
});

// ── 카드뉴스 콘텐츠 추출 ────────────────────────────────
app.post('/api/cardnews', apiLimiter, async (req, res) => {
  const { article } = req.body;
  if (!article?.trim()) return res.status(400).json({ error: '원고를 입력해주세요.' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY가 설정되지 않았습니다.' });

  try {
    const message = await anthropic.messages.create({
      model:      process.env.MODEL || 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: `당신은 인스타그램 카드뉴스 전문 에디터입니다.
주어진 원고를 분석해 6장의 카드뉴스 콘텐츠를 JSON으로만 반환합니다.
body1·body2는 각각 자연스러운 지점에 \\n을 넣어 2줄로 표시되도록 작성합니다.
JSON 이외의 텍스트(설명, 마크다운 코드블록 포함)는 절대 출력하지 마세요.`,
      messages: [{
        role: 'user',
        content: `다음 원고로 인스타그램 트렌드 카드뉴스 6장을 만들어주세요.

원고:
${article.trim()}

반드시 아래 JSON 형식으로만 응답하세요:
{
  "bgKeyword": "Unsplash 검색용 영문 키워드 2~3단어 (주제와 관련된 추상·자연·사물 장면)",
  "cards": [
    {"type":"title","title":"메인 제목(18자 이내)","subtitle":"흥미로운 부제목(30자 이내)","emoji":"이모지1개"},
    {"type":"content","num":1,"headline":"핵심 포인트(14자 이내)","body1":"1줄 내용(25자)\\n2줄 내용(25자)","body2":"보충 1줄(25자)\\n보충 2줄(25자)","emoji":"이모지1개"},
    {"type":"content","num":2,"headline":"핵심 포인트(14자 이내)","body1":"1줄 내용(25자)\\n2줄 내용(25자)","body2":"보충 1줄(25자)\\n보충 2줄(25자)","emoji":"이모지1개"},
    {"type":"content","num":3,"headline":"핵심 포인트(14자 이내)","body1":"1줄 내용(25자)\\n2줄 내용(25자)","body2":"보충 1줄(25자)\\n보충 2줄(25자)","emoji":"이모지1개"},
    {"type":"content","num":4,"headline":"핵심 포인트(14자 이내)","body1":"1줄 내용(25자)\\n2줄 내용(25자)","body2":"보충 1줄(25자)\\n보충 2줄(25자)","emoji":"이모지1개"},
    {"type":"cta","headline":"마무리 핵심 메시지(18자 이내)","body1":"행동 유도 1줄(25자)\\n행동 유도 2줄(25자)","body2":"공감 마무리 1줄(22자)\\n공감 마무리 2줄(22자)","emoji":"이모지1개"}
  ]
}`
      }]
    });

    const raw   = message.content[0].text.trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ error: '카드 데이터 파싱 실패. 다시 시도해주세요.' });

    const data = JSON.parse(match[0]);
    const cTitle = data.cards?.[0]?.title || data.cards?.[0]?.headline || '카드뉴스';
    const crow = db.prepare(
      'INSERT INTO cardnews_posts (title, cards_json, tokens_in, tokens_out) VALUES (?, ?, ?, ?)'
    ).run(cTitle, JSON.stringify(data.cards), message.usage.input_tokens, message.usage.output_tokens);
    res.json({ id: crow.lastInsertRowid, ...data, tokensIn: message.usage.input_tokens, tokensOut: message.usage.output_tokens });
  } catch (err) {
    console.error('[cardnews]', err.message);
    if (err.status === 401) return res.status(401).json({ error: 'API 키가 유효하지 않습니다.' });
    res.status(500).json({ error: `카드뉴스 생성 실패: ${err.message}` });
  }
});

// ── Health check ────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

// ── Start ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ 블로그 자동화 서버 실행 중 → http://localhost:${PORT}\n`);
});
