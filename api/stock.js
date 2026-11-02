/**
 * Vercel Serverless Function: 주식 시세 프록시 심부름꾼 (/api/stock.js)
 * 
 * [특징]
 * 1. 무설치 / 의존성 제로 (Node.js 18+ 내장 fetch 및 CommonJS 기반)
 * 2. 브라우저 CORS 문제 원천 해결 (Access-Control-Allow-Origin: *)
 * 3. 6자리 종목코드(.KS/.KQ 자동 판별) 및 대표 50대 종목 한글/영문 심볼 매핑 지원
 * 4. TradingView Lightweight Charts 호환 일봉(캔들) 및 당일 OHLC 시세 데이터 반환
 * 5. 데이터 부재/실패 시 프로젝트 개발 규칙에 따라 "불러오기 실패" 명확히 반환
 */

// 대표 50대 종목 사전 매핑 테이블 (한국 대형주 코스피/코스닥 + 별칭 지원)
const STOCK_MAP = {
  // 코스피 대표 종목
  '삼성전자': '005930.KS',
  '삼성전자우': '005935.KS',
  'SK하이닉스': '000660.KS',
  'LG에너지솔루션': '373220.KS',
  '삼성바이오로직스': '207940.KS',
  '현대차': '005380.KS',
  '기아': '000270.KS',
  '셀트리온': '068270.KS',
  'KB금융': '105560.KS',
  '네이버': '035420.KS',
  'NAVER': '035420.KS',
  '신한지주': '055550.KS',
  '포스코홀딩스': '005490.KS',
  'POSCO홀딩스': '005490.KS',
  '현대모비스': '012330.KS',
  '카카오': '035720.KS',
  '삼성물산': '028260.KS',
  'LG화학': '051910.KS',
  '삼성SDI': '006400.KS',
  '고려아연': '010130.KS',
  '메리츠금융지주': '138040.KS',
  '하나금융지주': '086790.KS',
  'HD현대중공업': '329180.KS',
  '크래프톤': '259960.KS',
  'LG전자': '066570.KS',
  '삼성생명': '032830.KS',
  'HMM': '011200.KS',
  '한국전력': '015760.KS',
  'KT&G': '033780.KS',
  '포스코퓨처엠': '003670.KS',
  '카카오뱅크': '323410.KS',
  '두산에너빌리티': '034020.KS',
  '우리금융지주': '316140.KS',
  '기업은행': '024110.KS',
  'KT': '030200.KS',
  'SK이노베이션': '096770.KS',
  '한화에어로스페이스': '012450.KS',
  'HD한국조선해양': '009540.KS',
  '에쓰오일': '010950.KS',
  'S-Oil': '010950.KS',

  // 코스닥 대표 종목
  '에코프로비엠': '247540.KQ',
  '에코프로': '086520.KQ',
  'HLB': '028300.KQ',
  '알테오젠': '196170.KQ',
  '엔켐': '348370.KQ',
  '삼천당제약': '000250.KQ',
  '리노공업': '058470.KQ',
  '레인보우로보틱스': '277810.KQ',
  'HPSP': '403870.KQ',
  '클래시스': '214150.KQ',
  '리가켐바이오': '141080.KQ',
  '휴젤': '145020.KQ',
  '펄어비스': '263750.KQ',
  'JYP': '035900.KQ',
  'JYPEnt': '035900.KQ',
  'JYP Ent.': '035900.KQ',
  '에스엠': '041510.KQ',
  'SM': '041510.KQ',
  '카카오게임즈': '293490.KQ',
  '셀트리온제약': '068760.KQ',
  '솔브레인': '357780.KQ',
  '동진쎄미켐': '005290.KQ',
  '씨젠': '096530.KQ',
  '원익IPS': '240810.KQ'
};

// 심볼 코드 -> 대표 종목명 역매핑 테이블
const REVERSE_STOCK_MAP = {};
for (const [name, sym] of Object.entries(STOCK_MAP)) {
  const code = sym.split('.')[0];
  if (!REVERSE_STOCK_MAP[sym]) REVERSE_STOCK_MAP[sym] = name;
  if (!REVERSE_STOCK_MAP[code]) REVERSE_STOCK_MAP[code] = name;
}

/**
 * Yahoo Finance v8 chart API 호출 함수
 */
async function fetchYahooChart(symbol) {
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const headers = {
    'User-Agent': userAgent,
    'Accept': 'application/json'
  };

  // 커스텀 API 키 확장 지원 자리 (환경변수 STOCK_API_KEY 등록 시)
  if (process.env.STOCK_API_KEY) {
    headers['X-API-KEY'] = process.env.STOCK_API_KEY;
  }

  const hosts = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

  for (const host of hosts) {
    try {
      const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d&includePrePost=false`;
      const res = await fetch(url, { headers });
      if (!res.ok) continue;

      const data = await res.json();
      const chartResult = data?.chart?.result?.[0];
      if (chartResult && chartResult.timestamp && chartResult.timestamp.length > 0) {
        return chartResult;
      }
    } catch (e) {
      // 다음 호스트로 재시도
    }
  }

  return null;
}

/**
 * 날짜 포맷팅 헬퍼 (YYYY-MM-DD, KST 기준 정밀 보정)
 */
function formatKSTDate(timestampSeconds) {
  // 한국 표준시 (UTC+9) 기준 일자 추출
  const date = new Date((timestampSeconds + 9 * 3600) * 1000);
  return date.toISOString().split('T')[0];
}

/**
 * Vercel Serverless Function 메인 핸들러
 */
module.exports = async function handler(req, res) {
  // 1. CORS 헤더 완비
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  // Preflight 요청 대응
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      error: '불러오기 실패',
      message: 'GET 요청만 지원합니다.'
    });
  }

  try {
    // 2. 쿼리 파라미터 추출 (?code= 또는 ?symbol=)
    const rawQuery = (req.query?.code || req.query?.symbol || '').trim();
    if (!rawQuery) {
      return res.status(400).json({
        error: '불러오기 실패',
        message: '종목코드 또는 종목명을 query parameter(?code=...)로 전달해주세요.'
      });
    }

    const cleanQuery = rawQuery.replace(/\s+/g, '');
    let targetSymbols = [];
    let displayName = cleanQuery;

    // 종목명 사전 조회
    if (STOCK_MAP[cleanQuery]) {
      targetSymbols.push(STOCK_MAP[cleanQuery]);
      displayName = cleanQuery;
    } else if (STOCK_MAP[rawQuery]) {
      targetSymbols.push(STOCK_MAP[rawQuery]);
      displayName = rawQuery;
    } else if (/^\d{6}$/.test(cleanQuery)) {
      // 6자리 숫자인 경우 코스피(.KS) 먼저, 실패 시 코스닥(.KQ) 시도
      targetSymbols.push(`${cleanQuery}.KS`, `${cleanQuery}.KQ`);
      displayName = REVERSE_STOCK_MAP[cleanQuery] || cleanQuery;
    } else {
      // 사용자가 직접 접미사를 입력했거나(005930.KS), 미국 주식(AAPL 등)인 경우
      targetSymbols.push(cleanQuery.toUpperCase());
    }

    // 3. 야후 파이낸스 시세 데이터 조회 (순차 시도)
    let chartResult = null;
    let successfulSymbol = null;

    for (const sym of targetSymbols) {
      chartResult = await fetchYahooChart(sym);
      if (chartResult) {
        successfulSymbol = sym;
        break;
      }
    }

    // 데이터가 없거나 조회 실패 시 가짜 숫자 없이 명확히 실패 반환
    if (!chartResult || !chartResult.timestamp || chartResult.timestamp.length === 0) {
      return res.status(404).json({
        error: '불러오기 실패',
        message: `'${rawQuery}' 종목 데이터를 가져올 수 없습니다. 종목코드나 이름을 확인해주세요.`
      });
    }

    // 4. 시세 및 캔들 데이터 가공 (TradingView Lightweight Charts 포맷 호환)
    const meta = chartResult.meta || {};
    const timestamps = chartResult.timestamp || [];
    const quotes = chartResult.indicators?.quote?.[0] || {};
    const opens = quotes.open || [];
    const highs = quotes.high || [];
    const lows = quotes.low || [];
    const closes = quotes.close || [];
    const volumes = quotes.volume || [];

    const candles = [];
    for (let i = 0; i < timestamps.length; i++) {
      const o = opens[i];
      const h = highs[i];
      const l = lows[i];
      const c = closes[i];
      const v = volumes[i] ?? 0;

      // 휴장일 등으로 인한 null/NaN 데이터 제외
      if (o == null || h == null || l == null || c == null || isNaN(o) || isNaN(c)) {
        continue;
      }

      candles.push({
        time: formatKSTDate(timestamps[i]),
        open: Math.round(o * 100) / 100,
        high: Math.round(h * 100) / 100,
        low: Math.round(l * 100) / 100,
        close: Math.round(c * 100) / 100,
        volume: Math.round(v)
      });
    }

    if (candles.length === 0) {
      return res.status(404).json({
        error: '불러오기 실패',
        message: `'${rawQuery}' 종목의 유효한 일봉 데이터가 없습니다.`
      });
    }

    // 최근 일봉 60개 추출 (최신순 또는 시간순 유지 - 차트는 시간 오름차순 필요)
    const recentCandles = candles.slice(-60);

    // 최신 일봉 기준 당일 시세 정보 산출
    const latest = recentCandles[recentCandles.length - 1];
    const prev = recentCandles.length >= 2 ? recentCandles[recentCandles.length - 2] : null;

    const prevClose = prev ? prev.close : (meta.chartPreviousClose || latest.open);
    const change = Math.round((latest.close - prevClose) * 100) / 100;
    const changeRate = prevClose ? Math.round(((change / prevClose) * 100) * 100) / 100 : 0;

    // 최종 응답 반환
    return res.status(200).json({
      symbol: successfulSymbol,
      code: successfulSymbol.replace(/\.(KS|KQ)$/i, ''),
      name: REVERSE_STOCK_MAP[successfulSymbol] || REVERSE_STOCK_MAP[successfulSymbol.split('.')[0]] || displayName,
      currency: meta.currency || (successfulSymbol.endsWith('.KS') || successfulSymbol.endsWith('.KQ') ? 'KRW' : 'USD'),
      date: latest.time,
      open: latest.open,
      high: latest.high,
      low: latest.low,
      close: latest.close,
      volume: latest.volume,
      change: change,
      changeRate: changeRate,
      candles: recentCandles
    });

  } catch (error) {
    // 예외 발생 시 규칙 준수: 절대 임의 mock 수치를 넣지 않고 명확히 실패 반환
    return res.status(500).json({
      error: '불러오기 실패',
      message: error.message || '서버 내부 오류가 발생했습니다.'
    });
  }
};
