import { connection } from "next/server";
import { Home } from "@/components/home";
import { endpointModels } from "@/lib/endpoints";

// The home page. The launch form is a client component; this server half
// hands it the custom endpoints from EVALBOARD_ENDPOINTS by name, so their
// URLs never reach the browser.
export default async function Page() {
  await connection(); // read the config at request time, as POST /api/runs does
  let models: string[] = [];
  let error = "";
  try {
    models = endpointModels();
  } catch (err) {
    console.error("[home]", err);
    error = (err as Error).message;
  }
  return <Home endpointModels={models} endpointError={error} />;
}
