import { DEMO_LINE, SAMPLE_STOP, normPhrase } from "../../shared/demo";
import type { LangCode } from "../../shared/languages";

export const PHRASES: Record<string, Partial<Record<LangCode, string>>> = {
  [normPhrase(DEMO_LINE)]: {
    de: "Willkommen in der Hagia Sophia in Istanbul. Diese große Kirche wurde im sechsten Jahrhundert erbaut. Bitte achten Sie auf die Rampe.",
    es: "Bienvenidos a Hagia Sophia en Istanbul. Esta gran iglesia se construyó en el siglo sexto. Por favor, tengan cuidado con la rampa.",
    fr: "Bienvenue à Hagia Sophia, à Istanbul. Cette grande église a été construite au sixième siècle. Faites attention à la rampe.",
    it: "Benvenuti a Hagia Sophia, a Istanbul. Questa grande chiesa fu costruita nel sesto secolo. Attenzione alla rampa.",
    ru: "Добро пожаловать в Hagia Sophia в Istanbul. Эта великая церковь была построена в шестом веке. Пожалуйста, смотрите под ноги у пандуса.",
    ar: "مرحبًا بكم في Hagia Sophia في Istanbul. بُنيت هذه الكنيسة العظيمة في القرن السادس. يرجى الانتباه قرب المنحدر.",
    tr: "Istanbul'daki Hagia Sophia'ya hoş geldiniz. Bu büyük kilise altıncı yüzyılda inşa edildi. Lütfen rampa yanında adımınıza dikkat edin.",
    pl: "Witamy w Hagia Sophia w Istanbul. Ten wielki kościół zbudowano w szóstym wieku. Proszę uważać przy rampie.",
    ms: "Selamat datang ke Hagia Sophia di Istanbul. Gereja besar ini dibina pada abad keenam. Sila berhati-hati di tanjakan.",
    ja: "IstanbulのHagia Sophiaへようこそ。この大きな教会は6世紀に建てられました。スロープのそばでは足元にご注意ください。",
    zh: "欢迎来到 Istanbul 的 Hagia Sophia。这座宏伟的教堂建于六世纪。请在坡道附近注意脚下。",
    pt: "Bem-vindos à Hagia Sophia em Istanbul. Esta grande igreja foi construída no século sexto. Cuidado com a rampa.",
  },
  [normPhrase(SAMPLE_STOP.script)]: {
    de: "Das ist die Basilica Cistern in Istanbul. Kaiser Justinian hat sie im sechsten Jahrhundert gebaut, um Wasser für den Palast zu speichern. Achten Sie auf den nassen Boden.",
    es: "Esta es la Basilica Cistern en Istanbul. El emperador Justinian la construyó en el siglo sexto para guardar agua para el palacio. Cuidado con el suelo mojado.",
    fr: "Voici la Basilica Cistern à Istanbul. L'empereur Justinian l'a construite au sixième siècle pour stocker l'eau du palais. Attention au sol mouillé.",
    it: "Questa è la Basilica Cistern a Istanbul. L'imperatore Justinian la costruì nel sesto secolo per conservare l'acqua del palazzo. Attenzione al pavimento bagnato.",
    ru: "Это Basilica Cistern в Istanbul. Император Justinian построил её в шестом веке, чтобы хранить воду для дворца. Осторожно, мокрый пол.",
    ar: "هذه Basilica Cistern في Istanbul. بناها الإمبراطور Justinian في القرن السادس لتخزين الماء للقصر. انتبهوا للأرض المبللة.",
    tr: "Burası Istanbul'daki Basilica Cistern. İmparator Justinian, saray için su depolamak üzere onu altıncı yüzyılda inşa ettirdi. Islak zemine dikkat edin.",
    pl: "To jest Basilica Cistern w Istanbul. Cesarz Justinian zbudował ją w szóstym wieku, by gromadzić wodę dla pałacu. Uważajcie na mokrą podłogę.",
    ms: "Ini ialah Basilica Cistern di Istanbul. Maharaja Justinian membinanya pada abad keenam untuk menyimpan air istana. Hati-hati dengan lantai yang basah.",
    ja: "ここは Istanbul の Basilica Cistern です。Justinian 帝が6世紀に宮殿の水を貯めるために造りました。濡れた床に注意してください。",
    zh: "这里是 Istanbul 的 Basilica Cistern。Justinian 皇帝于六世纪建造它，为宫殿储水。请留意湿滑的地面。",
    pt: "Esta é a Basilica Cistern em Istanbul. O imperador Justinian construiu-a no século sexto para guardar água para o palácio. Cuidado com o chão molhado.",
  },
};

export const QUESTIONS_TO_ENGLISH: Record<string, string> = {
  "wo ist die toilette": "Where is the toilet?",
  "dónde está la salida": "Where is the exit?",
  "où sont les toilettes": "Where are the toilets?",
  "dove è il bagno": "Where is the toilet?",
  "где туалет": "Where is the toilet?",
  "أين الحمام": "Where is the toilet?",
  "tuvalet nerede": "Where is the toilet?",
  "gdzie jest toaleta": "Where is the toilet?",
  "di mana tandas": "Where is the toilet?",
  "トイレはどこですか": "Where is the toilet?",
  "洗手间在哪里": "Where is the toilet?",
  "onde fica a casa de banho": "Where is the toilet?",
  "where is the toilet": "Where is the toilet?",
};

const LEXICON: Partial<Record<LangCode, Record<string, string>>> = {
  de: {
    tomorrow: "morgen",
    we: "wir",
    visit: "besuchen",
    and: "und",
    the: "die",
    this: "dies",
    is: "ist",
    please: "bitte",
    welcome: "willkommen",
    of: "von",
    to: "nach",
  },
  es: { and: "y", the: "el", this: "esto", is: "es", please: "por favor", welcome: "bienvenidos", tomorrow: "mañana", we: "nosotros", visit: "visitamos" },
  fr: { and: "et", the: "le", this: "ceci", is: "est", please: "s'il vous plaît", welcome: "bienvenue", tomorrow: "demain", we: "nous", visit: "visitons" },
  it: { and: "e", the: "il", this: "questo", is: "è", please: "per favore", tomorrow: "domani", we: "noi", visit: "visitiamo" },
  pt: { and: "e", the: "o", this: "isto", is: "é", please: "por favor", tomorrow: "amanhã", we: "nós", visit: "visitamos" },
  tr: { and: "ve", the: "", this: "bu", is: "", please: "lütfen", tomorrow: "yarın", we: "biz", visit: "ziyaret" },
  pl: { and: "i", the: "", this: "to", is: "jest", please: "proszę", tomorrow: "jutro", we: "my", visit: "odwiedzamy" },
  ru: { and: "и", the: "", this: "это", is: "", please: "пожалуйста", tomorrow: "завтра", we: "мы", visit: "посещаем" },
  ar: { and: "و", the: "", this: "هذا", please: "من فضلك", tomorrow: "غدًا", we: "نحن", visit: "نزور" },
  ms: { and: "dan", the: "", this: "ini", is: "ialah", please: "sila", tomorrow: "esok", we: "kami", visit: "melawat" },
  ja: { and: "と", the: "", this: "これ", please: "どうぞ", tomorrow: "明日", we: "私たちは", visit: "訪れます" },
  zh: { and: "和", the: "", this: "这", please: "请", tomorrow: "明天", we: "我们", visit: "参观" },
};

export function looseKey(value: string): string {
  return normPhrase(value)
    .replace(/^[¿¡]+/u, "")
    .replace(/[?？!！.。]+$/u, "")
    .trim();
}

export function phraseFor(english: string, lang: LangCode): string | undefined {
  return PHRASES[normPhrase(english)]?.[lang];
}

export function questionToEnglish(text: string): string | undefined {
  return QUESTIONS_TO_ENGLISH[looseKey(text)];
}

export function pseudoTranslate(text: string, lang: LangCode): string {
  const dict = LEXICON[lang] ?? {};
  return text
    .split(/(\s+)/)
    .map((part) => {
      if (/^\s+$/.test(part) || part.includes("⟦")) return part;
      const match = part.match(/^([^A-Za-zÀ-ÿĀ-ž']*)([A-Za-zÀ-ÿĀ-ž']+)(.*)$/);
      if (!match) return part;
      const replacement = dict[match[2].toLowerCase()];
      if (!replacement) return part;
      const cased =
        match[2][0] === match[2][0].toUpperCase() ? replacement.charAt(0).toUpperCase() + replacement.slice(1) : replacement;
      return `${match[1]}${cased}${match[3]}`;
    })
    .join("");
}
