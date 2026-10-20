// Content rules checked before any xAI call. This is a word-and-pattern tripwire, not a
// classifier: Claude's own judgment and xAI's moderation come first, and a person looks at
// the output before it goes anywhere public. The hard rule it backs: no Grok media for
// anything children or teens use, and nothing that depicts them.

interface Rule {
	reason: string;
	pattern: RegExp;
}

const word = (alternatives: string) => new RegExp(`\\b(?:${alternatives})\\b`, "i");

const RULES: Rule[] = [
	{
		reason: "it mentions children or teens",
		pattern: word(
			[
				"child(?:ren|hood|ish)?",
				"kids?",
				"kiddos?",
				"toddlers?",
				"bab(?:y|ies)",
				"infants?",
				"newborns?",
				"(?:pre)?teens?",
				"teenagers?",
				"tweens?",
				"minors?",
				"juveniles?",
				"youths?",
				"adolescents?",
				"youngsters?",
				"freshm[ae]n",
				"sophomores?",
				"(?:1st|2nd|3rd|[4-9]th|1[0-2]th) graders?",
				"loli",
				"underage",
				"boys?",
				"girls?",
				"school ?(?:boys?|girls?|kids?|children)",
				"students?",
				"pupils?",
				"sons?",
				"daughters?",
				"nieces?",
				"nephews?",
				"grandkids?",
				"grandchild(?:ren)?",
				"kindergarten",
				"preschool",
				"nursery",
				"elementary school",
				"middle school",
				"high school",
				"junior high",
				"(?:1st|2nd|3rd|[4-9]th|1[0-2]th) grade",
				"grade (?:[1-9]|1[0-2])",
				"playground",
				"lolita",
			].join("|"),
		),
	},
	{
		reason: "it gives an age under 18",
		pattern:
			/\b(?:[0-9]|1[0-7])[- ]?(?:years?|yrs?|y\.?\s?o\.?)(?:[- ]?old)?\b|\baged? (?:[0-9]|1[0-7])\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)[- ]?years?[- ]?old\b/i,
	},
	{
		reason: "it is sexual",
		pattern: word(
			"nude|nudity|naked|nsfw|sex|sexy|sexual|erotic|porn\\w*|lingerie|topless|bottomless|explicit|fetish|seductive|undress\\w*|onlyfans",
		),
	},
	{
		reason: "it is gory",
		pattern: word(
			"gore|gory|bloody|blood ?soaked|dismember\\w*|decapitat\\w*|mutilat\\w*|corpses?|disembowel\\w*|beheading|torture\\w*|self[- ]harm|suicide",
		),
	},
	{
		reason: "it asks for weapon instructions",
		pattern:
			/\b(?:how to|instructions?|steps?|guide|recipe|blueprints?|schematics?)\b.{0,40}\b(?:bombs?|explosives?|ied|guns?|firearms?|silencers?|suppressors?|weapons?|napalm|nerve agent|ghost gun)\b|\b3d[- ]?print(?:ed|ing)? (?:guns?|firearms?)\b/i,
	},
	{
		reason: "it names a logo, brand or trademarked character",
		pattern: word(
			[
				"logos?",
				"trademark\\w*",
				"disney",
				"pixar",
				"marvel",
				"dc comics",
				"nintendo",
				"pok[eé]mon",
				"pikachu",
				"mario",
				"mickey mouse",
				"spider-?man",
				"batman",
				"superman",
				"star wars",
				"harry potter",
				"barbie",
				"hello kitty",
				"coca[- ]cola",
				"nike",
				"adidas",
				"apple logo",
				"mcdonald'?s",
				"lego",
			].join("|"),
		),
	},
	{
		reason: "it depicts a real, named person",
		pattern: word(
			"celebrit(?:y|ies)|president|prime minister|senator|politician|deepfake|look ?alike|in the likeness of|photo of (?:the )?(?:actor|actress|singer|rapper|athlete|ceo)",
		),
	},
];

export interface Refusal {
	refused: true;
	reason: string;
}

function familyPattern(familyNames: string | undefined): RegExp | undefined {
	const names = (familyNames ?? "")
		.split(/[,\n]/)
		.map((name) => name.trim())
		.filter((name) => name.length >= 2)
		.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
	return names.length ? new RegExp(`\\b(?:${names.join("|")})\\b`, "i") : undefined;
}

/**
 * Checks text that would be sent to xAI. Returns a refusal naming the rule, or undefined.
 * The reason never quotes the matched words, so a family name in the list is not echoed back.
 */
export function checkContent(text: string, familyNames?: string): Refusal | undefined {
	// Zero-width characters and soft hyphens would otherwise split words past the \b checks.
	const normalized = text.normalize("NFKC").replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, "");
	const family = familyPattern(familyNames);
	if (family?.test(normalized)) {
		return { refused: true, reason: "it names someone on the private family list" };
	}
	for (const rule of RULES) {
		if (rule.pattern.test(normalized)) return { refused: true, reason: rule.reason };
	}
	return undefined;
}

export const CONTENT_RULE_TEXT =
	"Rules: never for anything children or teens use, and never depicting children, teens, family members, real named people, sexual content, gore, weapon instructions, logos or trademarked characters. The server refuses those before calling xAI.";
