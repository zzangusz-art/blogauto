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
  '정보성': '유용한 정보를 명확하고 쉽게 전달하는 정보성 문체로. 수치, 사실, 팁을 적극 활용하세요.',
  '친근한': '독자와 대화하듯 편안하고 친근한 구어체로. 이모지는 사용하지 않습니다.',
  '전문적': '전문성과 신뢰를 드러내는 격식체로. 전문 용어를 적절히 사용하되 독자가 이해할 수 있게 설명하세요.',
  '감성적': '독자의 공감을 이끌어내는 따뜻하고 감성적인 문체로. 경험과 감정을 담아 서술하세요.'
};

const LENGTH_MAP = {
  '짧게':  { desc: '600~900자 분량의 핵심만 담은 짧은 글로', sections: 2 },
  '보통':  { desc: '1200~1600자 분량의 충실한 글로',         sections: 3 },
  '길게':  { desc: '2000~2500자 분량의 깊이 있는 글로',       sections: 4 }
};

function buildPrompt(keywords, features, tone, length) {
  const toneGuide   = TONE_MAP[tone]   || TONE_MAP['정보성'];
  const lengthGuide = LENGTH_MAP[length] || LENGTH_MAP['보통'];

  return `다음 조건으로 블로그 글을 작성해주세요.

**키워드:** ${keywords}
${features ? `**특징 및 요구사항:** ${features}` : ''}
**글투:** ${toneGuide}
**분량:** ${lengthGuide.desc} (본문 섹션 ${lengthGuide.sections}개)

---

### 작성 규칙
1. 마크다운 형식으로 작성합니다
2. 제목(#)은 딱 하나만 사용하고, 소제목은 ##을 사용합니다
3. 첫 문단은 독자의 관심을 끄는 훅(Hook)으로 시작합니다
4. 키워드를 제목과 본문에 자연스럽게 반복 사용합니다 (SEO 최적화)
5. 마지막 섹션(## 마치며 또는 비슷한 제목)에서 핵심을 정리하고 독자에게 행동을 유도합니다
6. 글 맨 끝에 빈 줄을 추가하고, 다음 형식으로 태그를 추가합니다:
   \`태그: #태그1 #태그2 #태그3 #태그4 #태그5\`

지금 바로 블로그 글을 작성해주세요.`;
}

// ── Routes ───────────────────────────────────────────────

// POST /api/generate — 글 생성
app.post('/api/generate', apiLimiter, async (req, res) => {
  const { keywords, features = '', tone = '정보성', length = '보통' } = req.body;

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
      system: `당신은 SEO와 콘텐츠 마케팅에 특화된 한국어 전문 블로그 작가입니다.
독자가 처음부터 끝까지 읽고 싶어지는 매력적인 블로그 글을 마크다운 형식으로 작성합니다.
절대로 영어로 작성하지 않으며, 모든 글은 한국어로 작성합니다.`,
      messages: [{ role: 'user', content: buildPrompt(keywords.trim(), features.trim(), tone, length) }]
    });

    const content    = message.content[0].text;
    const titleMatch = content.match(/^#\s+(.+)/m);
    const title      = titleMatch ? titleMatch[1].trim() : keywords.split(',')[0].trim();

    const row = db.prepare(`
      INSERT INTO posts (keywords, features, tone, length, title, content, model, tokens_in, tokens_out)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      keywords.trim(),
      features.trim() || null,
      tone, length,
      title, content,
      message.model,
      message.usage.input_tokens,
      message.usage.output_tokens
    );

    res.json({
      id:        row.lastInsertRowid,
      title,
      content,
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

// ── Health check ────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

// ── Start ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ 블로그 자동화 서버 실행 중 → http://localhost:${PORT}\n`);
});
