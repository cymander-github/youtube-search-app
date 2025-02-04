/**
 * YouTube Data API v3를 사용하기 위한 API 키
 * 스크립트 프로퍼티에서 안전하게 가져옴
 */
function getApiKey() {
  return PropertiesService.getScriptProperties().getProperty('YOUTUBE_API_KEY');
}

/**
 * Google Apps Script 웹 앱의 진입점 함수
 * 웹 페이지를 초기화하고 필요한 설정을 적용
 * @returns {HtmlOutput} HTML 페이지 출력 객체
 */
function doGet() {
  const template = HtmlService.createTemplateFromFile('index');
  const output = template.evaluate()
    .setTitle('Mastering AI Models: A Step-by-Step Guide')
    .setFaviconUrl('https://www.google.com/favicon.ico')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .setSandboxMode(HtmlService.SandboxMode.IFRAME);
    
  // iframe 내에서 실행될 때 상단 배너 숨기기
  if (output.getContent().indexOf('script-application-sidebar') === -1) {
    output.addMetaTag('google-apps-script', 'hide-banner');
  }
  
  return output;
}

/**
 * YouTube 동영상을 검색하고 결과를 반환하는 함수
 * @param {string} keyword - 사용자가 입력한 검색어
 * @returns {Array} 검색된 동영상 정보 배열
 * 각 동영상 정보는 다음 속성을 포함:
 * - videoId: 동영상 고유 ID
 * - title: 동영상 제목
 * - channelTitle: 채널명
 * - publishDate: 게시일
 * - viewCount: 조회수
 * - subscriberCount: 채널 구독자 수
 */
function searchYouTubeVideos(keyword) {
  try {
    if (!keyword || keyword.trim() === '') return [];

    const response = YouTube.Search.list('snippet', {
      q: keyword,
      maxResults: 50,  // 더 많은 결과를 가져와서 필터링
      type: 'video',
      regionCode: 'KR'
    });

    if (!response || !response.items) return [];

    // Shorts가 아닌 동영상만 필터링
    const nonShortsVideos = response.items.filter(item => 
      !isShorts(item.id.videoId, item.snippet)
    );

    // 동영상 정보 수집 및 점수 계산
    const videos = nonShortsVideos.map(item => {
      const videoDetails = YouTube.Videos.list('statistics', {
        id: item.id.videoId
      });

      const channelDetails = YouTube.Channels.list('statistics', {
        id: item.snippet.channelId
      });

      const viewCount = Number(videoDetails?.items[0]?.statistics?.viewCount || 0);
      const subscriberCount = Number(channelDetails?.items[0]?.statistics?.subscriberCount || 0);
      const publishDate = new Date(item.snippet.publishedAt).getTime();
      const now = new Date().getTime();
      
      // 최신순 점수 계산 (최근 1년을 기준으로 정규화)
      const oneYearInMs = 365 * 24 * 60 * 60 * 1000;
      const ageInMs = now - publishDate;
      const recencyScore = Math.max(0, 1 - (ageInMs / oneYearInMs));

      // 조회수와 구독자수 정규화 (로그 스케일 사용)
      const viewScore = Math.log10(viewCount + 1) / 10;  // +1은 log(0) 방지
      const subScore = Math.log10(subscriberCount + 1) / 10;
      
      // 최종 점수 계산 (가중치: 최신순 50%, 조회수 30%, 구독자수 20%)
      const score = (recencyScore * 0.5) + (viewScore * 0.3) + (subScore * 0.2);

      return {
        videoId: item.id.videoId,
        title: item.snippet.title,
        channelTitle: item.snippet.channelTitle,
        publishDate: item.snippet.publishedAt,
        viewCount: viewCount,
        subscriberCount: subscriberCount,
        score: score
      };
    });

    // 점수를 기준으로 정렬
    const sortedVideos = videos
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);

    const cache = CacheService.getScriptCache();
    const cacheKey = 'search_' + keyword.trim().toLowerCase();
    cache.put(cacheKey, JSON.stringify(sortedVideos), 21600);
    return sortedVideos;

  } catch (error) {
    console.error('검색 오류:', error);
    throw new Error('검색 중 오류가 발생했습니다: ' + error.message);
  }
}

function calculateRelevanceScore(title, description, searchTerms) {
  let score = 0;
  
  for (const term of searchTerms) {
    if (term.length < 2) continue; // 너무 짧은 단어 제외
    
    // 제목에서 검색어 발견 시 가중치 부여
    if (title.includes(term)) {
      score += 3;
    }
    // 설명에서 검색어 발견 시 가중치 부여
    if (description.includes(term)) {
      score += 1;
    }
  }
  
  return score;
}

function getVideoStats(videoId) {
  const maxRetries = 3;
  let retryCount = 0;
  
  while (retryCount < maxRetries) {
    try {
      Utilities.sleep(500);
      return YouTube.Videos.list('statistics', {
        id: videoId
      });
    } catch (error) {
      retryCount++;
      if (retryCount === maxRetries) return null;
      Utilities.sleep(1000);
    }
  }
  return null;
}

function getChannelSubscriberCount(channelId) {
  try {
    const cacheKey = 'channel_' + channelId;
    const cache = CacheService.getScriptCache();
    const cached = cache.get(cacheKey);
    
    if (cached) return parseInt(cached) || 0;
    
    const response = YouTube.Channels.list('statistics', {
      id: channelId,
      fields: 'items/statistics/subscriberCount'
    });
    
    if (response?.items?.[0]?.statistics) {
      const count = parseInt(response.items[0].statistics.subscriberCount) || 0;
      cache.put(cacheKey, count.toString(), 21600);  // 6시간 캐시
      return count;
    }
    return 0;
  } catch (error) {
    console.error('Channel error:', error);
    return 0;
  }
}

/**
 * YouTube 동영상이 Shorts인지 확인하는 함수
 * @param {Object} video - 동영상 정보 객체
 * @returns {boolean} Shorts 여부
 */
function isShorts(videoId, snippet) {
  try {
    // 제목이나 설명에 Shorts 관련 키워드가 있는지 확인
    const shortsKeywords = ['#shorts', '#short', 'shorts', 'short', '쇼츠', '숏츠'];
    const title = snippet.title.toLowerCase();
    const description = snippet.description.toLowerCase();
    
    const hasShortKeyword = shortsKeywords.some(keyword => 
      title.includes(keyword) || description.includes(keyword)
    );

    // 동영상 길이 확인 (60초 이하면 Shorts로 간주)
    const videoDetails = YouTube.Videos.list('contentDetails', {
      id: videoId
    });

    if (videoDetails?.items?.[0]?.contentDetails?.duration) {
      const duration = videoDetails.items[0].contentDetails.duration;
      const seconds = parseDuration(duration);
      return hasShortKeyword || seconds <= 60;
    }

    return hasShortKeyword;
  } catch (error) {
    console.error('Shorts 확인 중 오류:', error);
    return false;
  }
}

/**
 * YouTube 동영상 길이를 초 단위로 변환
 * @param {string} duration - ISO 8601 형식의 길이 (예: PT1M30S)
 * @returns {number} 초 단위 길이
 */
function parseDuration(duration) {
  const matches = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  const hours = parseInt(matches[1] || 0);
  const minutes = parseInt(matches[2] || 0);
  const seconds = parseInt(matches[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function displayResults(videos) {
  const resultsDiv = document.getElementById('results');
  
  if (!videos || videos.length === 0) {
    resultsDiv.innerHTML = `
      <div class="no-results-container">
        검색 결과가 없습니다.
      </div>
    `;
    return;
  }
  
  resultsDiv.innerHTML = '';
  videos.forEach(video => {
    const videoHtml = `
      <div class="video-container">
        <div class="video-wrapper">
          <iframe 
            src="https://www.youtube.com/embed/${video.videoId}?enablejsapi=1"
            frameborder="0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowfullscreen
            loading="lazy">
          </iframe>
        </div>
        <h3 class="video-title">${video.title}</h3>
        <div class="channel-title">${video.channelTitle}</div>
        <div class="stats-container">
          <div>
            <div class="stat-value">${formatNumber(video.viewCount)}</div>
            <div class="stat-label">조회수</div>
          </div>
          <div>
            <div class="stat-value">${formatNumber(video.subscriberCount)}</div>
            <div class="stat-label">구독자</div>
          </div>
          <div>
            <div class="stat-value">${formatDate(video.publishDate)}</div>
            <div class="stat-label">게시일</div>
          </div>
        </div>
      </div>
    `;
    resultsDiv.innerHTML += videoHtml;
  });
}

function testYouTubeAPI() {
  try {
    Logger.log('=== YouTube API 테스트 시작 ===');
    
    // 1. API 키 확인
    Logger.log('API Key 확인 (마지막 4자리):');
    Logger.log(getApiKey().slice(-4));
    
    // 2. 간단한 검색 테스트
    Logger.log('\n기본 검색 테스트:');
    const searchResponse = YouTube.Search.list('snippet', {
      q: 'test video',
      maxResults: 1,
      type: 'video'
    });
    Logger.log('검색 응답:');
    Logger.log(searchResponse);
    
    // 3. 비디오 정보 테스트
    if (searchResponse.items && searchResponse.items.length > 0) {
      const videoId = searchResponse.items[0].id.videoId;
      Logger.log('\n비디오 정보 테스트:');
      const videoResponse = YouTube.Videos.list('statistics', {
        id: videoId
      });
      Logger.log('비디오 응답:');
      Logger.log(videoResponse);
    }
    
    // 4. 할당량 정보 (예상치)
    Logger.log('\n할당량 사용 예상:');
    Logger.log('Search.list 호출: 100 units');
    Logger.log('Videos.list 호출: 1 unit');
    
    return {
      status: 'success',
      message: 'API 테스트 완료'
    };
    
  } catch (error) {
    Logger.log('\n=== 오류 발생 ===');
    Logger.log('오류 타입: ' + error.name);
    Logger.log('오류 메시지: ' + error.message);
    Logger.log('전체 오류: ' + error.toString());
    
    return {
      status: 'error',
      error: error.toString()
    };
  }
}

function checkQuota() {
  try {
    const quotaResponse = YouTube.Search.list('snippet', {
      q: 'test',
      maxResults: 1
    });
    
    // 응답 헤더에서 할당량 정보 확인
    const quotaInfo = {
      quotaUsed: quotaResponse.pageInfo.totalResults,
      quotaLimit: 10000,  // 기본 일일 할당량
      remaining: 10000 - quotaResponse.pageInfo.totalResults
    };
    
    Logger.log('Quota Information:');
    Logger.log(quotaInfo);
    
    // 실제 API 호출 테스트
    Logger.log('Test API Response:');
    Logger.log(quotaResponse);
    
    return quotaInfo;
    
  } catch (error) {
    Logger.log('Error checking quota:');
    Logger.log(error);
    
    // 에러 메시지에서 할당량 초과 여부 확인
    if (error.toString().includes('quotaExceeded') || 
        error.toString().includes('quota')) {
      return {
        error: 'Quota exceeded',
        message: error.toString()
      };
    }
    
    return {
      error: 'API error',
      message: error.toString()
    };
  }
}

function testQuota() {
  try {
    const response = YouTube.Search.list('snippet', {
      q: 'test',
      maxResults: 1
    });
    
    Logger.log('API 호출 성공');
    Logger.log('응답 코드: ' + response.status);
    return true;
    
  } catch (error) {
    Logger.log('API 오류: ' + error.message);
    // 할당량 초과 여부 확인
    if (error.message.includes('quota') || 
        error.message.includes('quotaExceeded')) {
      Logger.log('할당량이 초과되었습니다');
    }
    return false;
  }
}

// 현재 사용자 권한 확인 함수
function checkAuthorization() {
  try {
    const test = YouTube.Search.list('snippet', {
      q: 'test',
      maxResults: 1
    });
    Logger.log('권한 확인 완료');
    return true;
  } catch (e) {
    Logger.log('권한 오류: ' + e.message);
    return false;
  }
}

// OAuth 범위 확인용 함수
function getOAuthScopes() {
  Logger.log('현재 OAuth 범위:');
  Logger.log(ScriptApp.getOAuthScopes());
  return ScriptApp.getOAuthScopes();
}

function testYouTubeAuth() {
  try {
    // YouTube 서비스가 활성화되어 있는지 확인
    Logger.log('YouTube 서비스 확인 중...');
    
    // 기본 API 호출 테스트
    const response = YouTube.Search.list('snippet', {
      q: 'test',
      maxResults: 1,
      type: 'video'
    });
    
    Logger.log('YouTube API 호출 성공!');
    Logger.log('응답:', response);
    
    // OAuth 스코프 확인
    const scopes = ScriptApp.getOAuthScopes();
    Logger.log('현재 OAuth 스코프:', scopes);
    
    return {
      status: 'success',
      message: 'YouTube API 연결 성공',
      scopes: scopes
    };
    
  } catch (error) {
    Logger.log('오류 발생:', error);
    return {
      status: 'error',
      message: error.toString()
    };
  }
}

function getWebAppUrl() {
  const url = ScriptApp.getService().getUrl();
  Logger.log('웹 앱 URL: ' + url);
  return url;
}
