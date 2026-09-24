import { QUESTIONNAIRE } from './schema/questionnaire';
export function renderQuestionnaire(): string {
  return ['# Blueprint discovery questionnaire', '', ...QUESTIONNAIRE.map((q, i) => `${i + 1}. ${q.question}\n   Field: \`${q.path}\`\n`)].join('\n');
}
