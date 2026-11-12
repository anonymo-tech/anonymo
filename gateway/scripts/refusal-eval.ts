// Anonymo WS03 · refusal-catch evaluation on an OR-Bench-Hard-style benign set. See src/anonymo/refusal/eval.ts.
//   bun scripts/refusal-eval.ts --set <path> [--limit 200] (--gateway <url> --key <key> [--model anonymo-1] [--models a,b] | --replies) [--min 0.95]
import { runEval } from "../src/anonymo/refusal/eval.ts";

process.exit(await runEval(process.argv.slice(2), (line) => console.log(line)));
