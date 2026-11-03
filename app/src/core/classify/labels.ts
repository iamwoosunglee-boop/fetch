export const KOREAN_NAMES: Readonly<Record<string, string>> = {
  AIR: '공기', AIRCRAFT: '항공기', ALARMS: '경보', AMBIENCE: '배경음', ANIMALS: '동물', ARCHIVED: '보관',
  BEEPS: '비프음', BELLS: '종', BIRDS: '새', BOATS: '배', BULLETS: '총알', CARTOON: '만화',
  CERAMICS: '도자기', CHAINS: '쇠사슬', CHEMICALS: '화학', CLOCKS: '시계', CLOTH: '천',
  COMMUNICATIONS: '통신', COMPUTERS: '컴퓨터', CREATURES: '괴물', CROWDS: '군중', DESIGNED: '합성음',
  DESTRUCTION: '파괴', 'DIRT & SAND': '흙과 모래', DOORS: '문', DRAWERS: '서랍', ELECTRICITY: '전기',
  EQUIPMENT: '장비', EXPLOSIONS: '폭발', FARTS: '방귀', FIGHT: '격투', FIRE: '불', FIREWORKS: '불꽃놀이',
  FOLEY: '폴리', 'FOOD & DRINK': '음식과 음료', FOOTSTEPS: '발소리', GAMES: '게임', GEOTHERMAL: '지열',
  GLASS: '유리', GORE: '고어', GUNS: '총', HORNS: '경적', HUMAN: '사람', ICE: '얼음', LASERS: '레이저',
  LEATHER: '가죽', 'LIQUID & MUD': '액체와 진흙', MACHINES: '기계', MAGIC: '마법', MECHANICAL: '기계 장치',
  METAL: '금속', MOTORS: '모터', MOVEMENT: '움직임', MUSICAL: '음악', 'NATURAL DISASTER': '자연재해',
  OBJECTS: '물건', PAPER: '종이', PLASTIC: '플라스틱', RAIN: '비', ROBOTS: '로봇', ROCKS: '바위',
  ROPE: '밧줄', RUBBER: '고무', SCIFI: 'SF', SNOW: '눈', SPORTS: '스포츠', SWOOSHES: '휘두름',
  TOOLS: '공구', TOYS: '장난감', TRAINS: '기차', 'USER INTERFACE': '화면 조작음', VEGETATION: '식물',
  VEHICLES: '차량', VOICES: '목소리', WATER: '물', WEAPONS: '무기', WEATHER: '날씨', WHISTLES: '호루라기',
  WIND: '바람', WINDOWS: '창문', WINGS: '날개', WOOD: '나무',
};

export const CATEGORY_NAMES = Object.keys(KOREAN_NAMES);

export function categoryLabel(category: string): string {
  return `${KOREAN_NAMES[category]} ${category}`;
}
