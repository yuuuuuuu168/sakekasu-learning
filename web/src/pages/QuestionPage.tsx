import { useParams } from 'react-router';
import { ErrorMessage, Loading } from '../components/Status';
import { api } from '../lib/api';
import { useApiResource } from '../lib/useApiResource';
import { QuestionView } from './question/QuestionView';

export function QuestionPage() {
  const { category = '', exam = '', id = '' } = useParams();
  // 「次の問題へ」で同じ画面のまま問題が替わるので、前の問題の応答が後から届いても捨てる
  const key = `${category}/${exam}/${id}`;
  const { data: question, error, reload } = useApiResource(key, () => api.question(category, exam, id));

  if (error) return <ErrorMessage message={error} onRetry={reload} />;
  if (!question) return <Loading />;
  // 問題ごとに作り直し、選択や採点結果を次の問題へ持ち越さない
  return <QuestionView key={key} category={category} exam={exam} question={question} />;
}
