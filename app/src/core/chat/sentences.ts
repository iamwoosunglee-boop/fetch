// Fixed chat sentences from PRD v4 7.3. Haiku writes the line only for text searches.

export const sentences = {
  quoted: '이름이 일치하는 파일을 가져왔어요.',
  quotedEmpty: '이 이름이 들어간 파일이 없어요. 따옴표를 빼고 찾아보세요.',
  waiting: ['fetch가 소리를 찾고 있어요.', '어떤 소리를 찾는지 살펴보고 있어요.', '폴더에서 소리를 찾아보고 있어요.'],
  waitingLong: '조금만 더 기다려 주세요. 열심히 찾고 있어요.',
  analysing: (count: number, total: number) => `아직 분석 중이라 ${total.toLocaleString('ko-KR')}개 중 ${count.toLocaleString('ko-KR')}개 안에서만 찾았어요.`,
  analysingLow: (count: number, total: number) => `아직 ${total.toLocaleString('ko-KR')}개 중 ${count.toLocaleString('ko-KR')}개 안에서만 찾았어요. 분석이 끝나면 더 맞는 소리가 나올 수 있어요.`,
  missingName: (request: string) => [...request].length > 20
    ? '가지고 있는 소리에서 요청에 맞는 소리를 찾지 못했어요.'
    : `가지고 있는 소리에서 "${request}"에 맞는 소리를 찾지 못했어요.`,
  exhausted: '이 요청으로 찾은 소리는 모두 보여 드렸어요. 새 대화에서 다시 찾아보세요.',
  noCandidate: '이 소리와 비슷한 소리가 아직 없어요.',
  noneAnalysed: '아직 분석한 소리가 없어요. 분석이 끝나면 찾을 수 있어요.',
  noResults: '찾는 소리가 없어요. 다른 말로 설명해 보세요.',
  lengthRemoved: '길이가 맞지 않아 빠진 소리가 있어요.',
  notAnalyzed: '이 소리는 아직 분석 중이에요. 분석이 끝나면 찾을 수 있어요.',
  tooLong: '200자까지 입력할 수 있어요.',
  unavailable: '지금은 소리를 찾지 못했어요. 다시 시도해 주세요.',
  partial: '일부만 찾았어요. 다시 시도하면 더 찾아볼게요.',
  referenceUnread: '요청을 읽지 못해 넣어 주신 소리와 비슷한 소리로 골랐어요. 다시 시도하면 요청까지 반영해 찾아볼게요.',
  dailyLimit: '오늘 찾을 수 있는 횟수를 다 썼어요. 오전 9시에 다시 찾을 수 있어요. 지금은 소리를 끌어다 놓으면 찾을 수 있어요.',
} as const;
