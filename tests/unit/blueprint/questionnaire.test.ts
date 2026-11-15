import { renderQuestionnaire } from '../../../src/blueprint/questionnaire';
import { QUESTIONNAIRE } from '../../../src/blueprint/schema/questionnaire';
it('renders every question numbered with its field path', () => {
  const md = renderQuestionnaire();
  for (const q of QUESTIONNAIRE) { expect(md).toContain(q.question); expect(md).toContain(`\`${q.path}\``); }
  expect(md.split('\n').filter(l => /^\d+\. /.test(l))).toHaveLength(QUESTIONNAIRE.length);
});
