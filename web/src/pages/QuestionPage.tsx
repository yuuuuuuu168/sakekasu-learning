import { useParams } from 'react-router';
import { ErrorMessage, Loading } from '../components/Status';
import { QuestionView } from './question/QuestionView';
import { useQuestion } from './question/useQuestion';

export function QuestionPage() {
  const { category = '', exam = '', id = '' } = useParams();
  const { key, question, error, reload } = useQuestion(category, exam, id);

  if (error) return <ErrorMessage message={error} onRetry={reload} />;
  if (!question) return <Loading />;
  // 問題ごとに作り直し、選択や採点結果を次の問題へ持ち越さない
  return <QuestionView key={key} category={category} exam={exam} question={question} />;
}
