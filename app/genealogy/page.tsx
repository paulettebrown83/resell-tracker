import AuthGate from '@/components/AuthGate'
import GenealogyFrame from '@/components/GenealogyFrame'
export default function GenealogyPage() {
  return <AuthGate area="genealogy"><GenealogyFrame /></AuthGate>
}
