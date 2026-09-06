import AuthGate from "@/components/AuthGate";
import ResaleWorkbench from "@/components/ResaleWorkbench";
export default function Page() {
  return (
    <AuthGate>
      <ResaleWorkbench />
    </AuthGate>
  );
}
