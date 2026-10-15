"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import "@/app/dashboard/workspace-services.css";
import { useT } from "@/lib/i18n";

type View = "chapters" | "agents" | "connections";
type Route = { family: string; available: boolean };
type Project = { id: string; title: string };
type Chapter = { id: string; name: string; owner: boolean; monthlyUsd6: string; usedUsd6: string };
type Run = {
  id: string;
  callId: string;
  state: string;
  prompt?: string;
  output: string;
  author?: string;
  createdAt: string;
  actualUsd6: string | null;
  maximumUsd6: string;
};
type Connection = {
  id: string;
  name: string;
  projectId: string;
  repository: string;
  path: string;
  ref: string;
  sha: string;
  fetchedAt: string;
  revoked: boolean;
};
type Agent = {
  id: string;
  name: string;
  projectId: string;
  family: string;
  connectionIds: string[];
  enabled: boolean;
  intervalHours: number;
  perRunUsd6: string;
  totalUsd6: string;
  usedUsd6: string;
  nextRunAt: string;
  error: string | null;
};
const usd = (n: string | null | undefined) =>
  n == null
    ? "Pending"
    : new Intl.NumberFormat("en", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 6,
      }).format(Number(n) / 1e6);
const units = (n: string) => {
  if (!/^\d+(?:\.\d{1,6})?$/.test(n)) throw Error("Enter an amount with up to six decimal places.");
  return String(Math.round(Number(n) * 1e6));
};
const when = (s: string) => new Date(s).toLocaleString();
const modelNames: Record<string, string> = {
  claude: "Claude",
  gpt: "GPT",
  gemini: "Gemini",
  grok: "Grok",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  llama: "Llama",
};

function Services({ view, accountId }: { view: View; accountId: string }) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [routes, setRoutes] = useState<Route[]>([]),
    [projects, setProjects] = useState<Project[]>([]),
    [project, setProject] = useState(""),
    [family, setFamily] = useState("gpt");
  const [chapters, setChapters] = useState<Chapter[]>([]),
    [chapter, setChapter] = useState(""),
    [detail, setDetail] = useState<{
      chapter: Chapter;
      members: { id?: string; name: string; owner: boolean }[];
      messages: Run[];
    } | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]),
    [agent, setAgent] = useState(""),
    [runs, setRuns] = useState<Run[]>([]),
    [connections, setConnections] = useState<Connection[]>([]);
  const [name, setName] = useState(""),
    [display, setDisplay] = useState(""),
    [monthly, setMonthly] = useState("5"),
    [invite, setInvite] = useState(""),
    [joinToken, setJoinToken] = useState(""),
    [prompt, setPrompt] = useState(""),
    [quote, setQuote] = useState<{
      maximumUsd6: string;
      prompt: string;
      family: string;
      key: string;
    } | null>(null);
  const [goal, setGoal] = useState(""),
    [interval, setIntervalHours] = useState("24"),
    [perRun, setPerRun] = useState("0.25"),
    [total, setTotal] = useState("5"),
    [sourceIds, setSourceIds] = useState<string[]>([]);
  const [repo, setRepo] = useState(""),
    [file, setFile] = useState("README.md"),
    [ref, setRef] = useState("main"),
    [sourcePreview, setSourcePreview] = useState("");
  const api = useCallback(
    async <T,>(path: string, body?: unknown, method?: string): Promise<T> => {
      const response = await fetch(`/api/${path}`, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: { "Content-Type": "application/json", "x-conclave-account-id": accountId },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      const data = (await response.json()) as { error?: { message?: string } };
      if (!response.ok) throw Error(data.error?.message ?? "The request could not be completed.");
      return data as T;
    },
    [accountId],
  );
  const selection = useRef("");
  selection.current = `${view}:${chapter}:${agent}`;
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const selected = `${view}:${chapter}:${agent}`,
      request = ++generation.current;
    const current = () => selection.current === selected && generation.current === request;
    if (view === "chapters") {
      const [list, newDetail] = await Promise.all([
        api<{ chapters: Chapter[]; routes: Route[] }>("chapters"),
        chapter ? api<NonNullable<typeof detail>>(`chapters/${chapter}`) : Promise.resolve(null),
      ]);
      if (current()) {
        setChapters(list.chapters);
        setRoutes(list.routes);
        setDetail(newDetail);
      }
    } else {
      const [p, cs, as, run] = await Promise.all([
        api<{ projects: Project[] }>("projects"),
        api<{ connections: Connection[]; routes: Route[] }>("connections"),
        view === "agents"
          ? api<{ agents: Agent[]; routes: Route[] }>("agents")
          : Promise.resolve(null),
        view === "agents" && agent
          ? api<{ runs: Run[] }>(`agents/${agent}`)
          : Promise.resolve(null),
      ]);
      if (current()) {
        setProjects(p.projects);
        setConnections(cs.connections);
        setRoutes(as?.routes ?? cs.routes);
        if (as) setAgents(as.agents);
        setRuns(run?.runs ?? []);
      }
    }
  }, [api, view, chapter, agent]);
  useEffect(() => {
    let active = true,
      inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        await refresh();
      } catch (e) {
        if (active)
          setError(e instanceof Error ? e.message : "The request could not be completed.");
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 6000);
    return () => {
      active = false;
      ++generation.current;
      window.clearInterval(timer);
    };
  }, [refresh]);
  async function act(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The request could not be completed.");
    } finally {
      setBusy(false);
    }
  }
  const workingProject = project || projects[0]?.id || "";
  const projectPicker = (
    <label>
      Project
      <select
        value={workingProject}
        onChange={(e) => {
          setProject(e.target.value);
          setSourceIds([]);
        }}
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.title}
          </option>
        ))}
      </select>
    </label>
  );
  const modelPicker = (
    <label>
      Model
      <select
        value={family}
        onChange={(e) => {
          setFamily(e.target.value);
          setQuote(null);
        }}
      >
        {routes
          .filter((r) => r.available)
          .map((r) => (
            <option key={r.family} value={r.family}>
              {modelNames[r.family] ?? r.family}
            </option>
          ))}
      </select>
    </label>
  );
  const output = (r: Run) => (
    <article className="ws-run" key={r.id}>
      <div className="ws-row">
        <strong>{r.author ?? when(r.createdAt)}</strong>
        <span>
          {r.state} · {usd(r.actualUsd6)}
        </span>
      </div>
      {r.prompt && <p>{r.prompt}</p>}
      <pre>
        {r.output ||
          (["failed", "cancelled"].includes(r.state)
            ? "This request did not produce a result."
            : "Waiting for the model response…")}
      </pre>
    </article>
  );
  return (
    <section className="cp-page ws-services">
      <header className="cp-page-heading">
        <h1>{view === "chapters" ? "Chapters" : view === "agents" ? "Agents" : "Connections"}</h1>
        <p>
          {view === "chapters"
            ? "Work together with a shared conversation and monthly allowance."
            : view === "agents"
              ? "Run a project brief once or on a schedule you control."
              : "Choose which sources your projects and agents can use."}
        </p>
      </header>
      {error && (
        <p role="alert" className="ws-error">
          {error}
        </p>
      )}
      {view !== "chapters" && !projects.length && (
        <button
          className="cp-button"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await api("projects", { title: "My project" });
            })
          }
        >
          Create a project
        </button>
      )}
      {view === "chapters" && (
        <>
          <div className="ws-tabs">
            {chapters.map((c) => (
              <button
                key={c.id}
                className="cp-button"
                aria-pressed={chapter === c.id}
                onClick={() => {
                  setChapter(c.id);
                  setDetail(null);
                  setInvite("");
                  setQuote(null);
                }}
              >
                {c.name}
              </button>
            ))}
            <button
              className="cp-button"
              onClick={() => {
                setChapter("");
                setDetail(null);
              }}
            >
              New Chapter
            </button>
          </div>
          {!chapter ? (
            <div className="ws-columns">
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    const c = await api<{ id: string }>("chapters", {
                      name,
                      displayName: display,
                      monthlyUsd6: units(monthly),
                    });
                    setChapter(c.id);
                    setName("");
                  });
                }}
              >
                <h2>Create a Chapter</h2>
                <label>
                  Name
                  <input
                    required
                    maxLength={80}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label>
                  Your display name
                  <input
                    required
                    maxLength={60}
                    value={display}
                    onChange={(e) => setDisplay(e.target.value)}
                  />
                </label>
                <label>
                  Monthly allowance (USD)
                  <input
                    required
                    type="number"
                    min="0.01"
                    max="1000"
                    step="0.01"
                    value={monthly}
                    onChange={(e) => setMonthly(e.target.value)}
                  />
                </label>
                <p className="cp-fineprint">
                  Members use your Purse balance within this shared allowance. It resets each month
                  in UTC. Unfinished requests still count.
                </p>
                <button disabled={busy} className="cp-button cp-button--red">
                  Create Chapter
                </button>
              </form>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act(async () => {
                    const c = await api<{ id: string }>("chapters/join", {
                      token: joinToken.trim(),
                      displayName: display,
                    });
                    setChapter(c.id);
                    setJoinToken("");
                  });
                }}
              >
                <h2>Join a Chapter</h2>
                <label>
                  Your display name
                  <input
                    required
                    maxLength={60}
                    value={display}
                    onChange={(e) => setDisplay(e.target.value)}
                  />
                </label>
                <label>
                  Invitation code
                  <input
                    required
                    autoComplete="off"
                    value={joinToken}
                    onChange={(e) => setJoinToken(e.target.value)}
                  />
                </label>
                <button disabled={busy} className="cp-button">
                  Join
                </button>
              </form>
            </div>
          ) : (
            detail && (
              <>
                <div className="ws-row">
                  <h2>{detail.chapter.name}</h2>
                  <span>
                    {usd(detail.chapter.usedUsd6)} of {usd(detail.chapter.monthlyUsd6)} used or
                    reserved this month
                  </span>
                </div>
                <details>
                  <summary>Members and allowance</summary>
                  {detail.members.map((m, index) => (
                    <div className="ws-row" key={m.id ?? `${m.name}:${index}`}>
                      <span>
                        {m.name}
                        {m.owner ? " · Owner" : ""}
                      </span>
                      {detail.chapter.owner && !m.owner && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              await api(`chapters/${chapter}/members/${m.id}`, undefined, "DELETE");
                            })
                          }
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                  {detail.chapter.owner && (
                    <>
                      <div className="ws-row">
                        <button
                          className="cp-button"
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              setInvite(
                                (await api<{ token: string }>(`chapters/${chapter}/invite`, {}))
                                  .token,
                              );
                            })
                          }
                        >
                          Create invitation
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              await api(`chapters/${chapter}/invites`, undefined, "DELETE");
                              setInvite("");
                            })
                          }
                        >
                          Revoke unused invitations
                        </button>
                      </div>
                      {invite && (
                        <label>
                          Single-use code · expires in 7 days
                          <input readOnly value={invite} onFocus={(e) => e.target.select()} />
                        </label>
                      )}
                      <form
                        className="ws-row"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void act(async () => {
                            await api(
                              `chapters/${chapter}`,
                              { monthlyUsd6: units(monthly) },
                              "PATCH",
                            );
                          });
                        }}
                      >
                        <label>
                          New monthly allowance (USD)
                          <input
                            type="number"
                            min="0.01"
                            max="1000"
                            step="0.01"
                            value={monthly}
                            onChange={(e) => setMonthly(e.target.value)}
                          />
                        </label>
                        <button disabled={busy} className="cp-button">
                          Save allowance
                        </button>
                      </form>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await api(`chapters/${chapter}`, undefined, "DELETE");
                            setChapter("");
                            setDetail(null);
                          })
                        }
                      >
                        Archive Chapter
                      </button>
                    </>
                  )}
                </details>
                <div aria-live="polite">
                  {detail.messages.map(output)}
                  {!detail.messages.length && (
                    <p>No questions yet. Everyone in this Chapter can see this conversation.</p>
                  )}
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(async () => {
                      const q = await api<{ maximumUsd6: string }>(`chapters/${chapter}/quote`, {
                        prompt,
                        family,
                      });
                      setQuote({ ...q, prompt, family, key: crypto.randomUUID() });
                    });
                  }}
                >
                  {modelPicker}
                  <label>
                    Question
                    <textarea
                      required
                      maxLength={12000}
                      value={prompt}
                      onChange={(e) => {
                        setPrompt(e.target.value);
                        setQuote(null);
                      }}
                    />
                  </label>
                  <button disabled={busy} className="cp-button">
                    Review cost
                  </button>
                </form>
                {quote && (
                  <div className="ws-review">
                    <p>
                      Reserve up to {usd(quote.maximumUsd6)} from the owner's Purse. Your question
                      goes to the inference gateway and selected model host.
                    </p>
                    <button
                      disabled={busy}
                      className="cp-button cp-button--red"
                      onClick={() =>
                        void act(async () => {
                          await api(`chapters/${chapter}/messages`, {
                            prompt: quote.prompt,
                            family: quote.family,
                            maximumUsd6: quote.maximumUsd6,
                            idempotencyKey: quote.key,
                          });
                          setPrompt("");
                          setQuote(null);
                        })
                      }
                    >
                      Approve and send
                    </button>
                  </div>
                )}
              </>
            )
          )}
        </>
      )}
      {view === "agents" && (
        <div className="ws-columns">
          <div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  const a = await api<{ id: string }>("agents", {
                    name,
                    instructions: goal,
                    projectId: workingProject,
                    family,
                    connectionIds: sourceIds,
                    intervalHours: Number(interval),
                    perRunUsd6: units(perRun),
                    totalUsd6: units(total),
                  });
                  setAgent(a.id);
                  setName("");
                  setGoal("");
                });
              }}
            >
              <h2>New agent</h2>
              <label>
                Name
                <input
                  required
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              {projectPicker}
              <label>
                Goal and instructions
                <textarea
                  required
                  maxLength={12000}
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                />
              </label>
              {modelPicker}
              <label>
                Hours between runs
                <input
                  type="number"
                  min="1"
                  max="168"
                  required
                  value={interval}
                  onChange={(e) => setIntervalHours(e.target.value)}
                />
              </label>
              <div className="ws-row">
                <label>
                  Maximum per run (USD)
                  <input
                    required
                    type="number"
                    min="0.01"
                    max="10"
                    step="0.01"
                    value={perRun}
                    onChange={(e) => setPerRun(e.target.value)}
                  />
                </label>
                <label>
                  Total allowance (USD)
                  <input
                    required
                    type="number"
                    min="0.01"
                    max="1000"
                    step="0.01"
                    value={total}
                    onChange={(e) => setTotal(e.target.value)}
                  />
                </label>
              </div>
              <fieldset>
                <legend>Connected context</legend>
                {connections
                  .filter((c) => !c.revoked && c.projectId === workingProject)
                  .map((c) => (
                    <label className="ws-check" key={c.id}>
                      <input
                        type="checkbox"
                        checked={sourceIds.includes(c.id)}
                        onChange={(e) =>
                          setSourceIds(
                            e.target.checked
                              ? [...sourceIds, c.id]
                              : sourceIds.filter((id) => id !== c.id),
                          )
                        }
                      />
                      {c.name}
                    </label>
                  ))}
                <p className="cp-fineprint">
                  Selected snapshots are sent with each run. Refresh them in Connections when you
                  want newer content.
                </p>
              </fieldset>
              <button disabled={busy || !workingProject} className="cp-button cp-button--red">
                Save agent
              </button>
              <p className="cp-fineprint">
                Saving does not start spending. Starting a schedule authorizes repeated model
                requests within both allowances. Agents produce text; they do not control apps or
                execute trades.
              </p>
            </form>
          </div>
          <div>
            <h2>Your agents</h2>
            {agents.map((a) => (
              <article className="ws-card" key={a.id}>
                <button
                  className="ws-select"
                  onClick={() => {
                    setAgent(a.id);
                    setRuns([]);
                  }}
                >
                  <strong>{a.name}</strong>
                </button>
                <p>
                  {modelNames[a.family] ?? a.family} ·{" "}
                  {a.enabled
                    ? `Every ${a.intervalHours} hours. Next: ${when(a.nextRunAt)}`
                    : "Paused"}
                </p>
                <p>
                  {usd(a.usedUsd6)} used or reserved of {usd(a.totalUsd6)} · maximum{" "}
                  {usd(a.perRunUsd6)} per run
                </p>
                {a.error && (
                  <p role="status">
                    Paused: {a.error.replaceAll("_", " ").toLowerCase()}. Check the balance,
                    allowance and selected connections.
                  </p>
                )}
                <div className="ws-actions">
                  <button
                    disabled={busy}
                    className="cp-button"
                    onClick={() =>
                      void act(async () => {
                        await api(`agents/${a.id}/run`, {});
                        setAgent(a.id);
                      })
                    }
                  >
                    Run once
                  </button>
                  {!a.enabled ? (
                    <button
                      disabled={busy}
                      className="cp-button"
                      onClick={() =>
                        void act(async () => {
                          await api(`agents/${a.id}/schedule`, {});
                          setAgent(a.id);
                        })
                      }
                    >
                      Start schedule
                    </button>
                  ) : (
                    <button
                      disabled={busy}
                      className="cp-button"
                      onClick={() =>
                        void act(async () => {
                          await api(`agents/${a.id}/pause`, {});
                        })
                      }
                    >
                      Pause and stop
                    </button>
                  )}
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await api(`agents/${a.id}`, undefined, "DELETE");
                        if (agent === a.id) {
                          setAgent("");
                          setRuns([]);
                        }
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
              </article>
            ))}
            {agent && (
              <>
                <h3>Results</h3>
                {runs.map(output)}
                {!runs.length && <p>No runs yet.</p>}
              </>
            )}
          </div>
        </div>
      )}
      {view === "connections" && (
        <>
          <div className="ws-card">
            <h2>Model access</h2>
            <p>
              {routes
                .filter((r) => r.available)
                .map((r) => modelNames[r.family] ?? r.family)
                .join(", ") || "Loading model availability…"}
            </p>
            <p className="cp-fineprint">
              Model requests share the text you approve with the inference gateway and selected
              model host. Wallet access stays under Account and Purse.
            </p>
          </div>
          <div className="ws-columns">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  await api("connections", {
                    name,
                    projectId: workingProject,
                    repository: repo,
                    path: file,
                    ref,
                  });
                  setName("");
                });
              }}
            >
              <h2>Connect a public GitHub file</h2>
              <label>
                Name
                <input
                  required
                  maxLength={80}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              {projectPicker}
              <label>
                Repository
                <input
                  required
                  placeholder="owner/repository"
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                />
              </label>
              <label>
                File path
                <input required value={file} onChange={(e) => setFile(e.target.value)} />
              </label>
              <label>
                Branch or commit
                <input required value={ref} onChange={(e) => setRef(e.target.value)} />
              </label>
              <p className="cp-fineprint">
                Read-only access to this public file. GitHub receives its repository, path and
                branch. The imported content stays in this project until you select it for an agent.
                No private repository access or account token is requested.
              </p>
              <button disabled={busy || !workingProject} className="cp-button cp-button--red">
                Connect and import
              </button>
            </form>
            <div>
              {connections.map((c) => (
                <article className="ws-card" key={c.id}>
                  <h3>{c.name}</h3>
                  <p>
                    {c.repository}/{c.path}
                  </p>
                  <p>
                    {c.revoked
                      ? "Revoked"
                      : `Imported ${when(c.fetchedAt)} · ${c.sha.slice(0, 12)}`}
                  </p>
                  {!c.revoked && (
                    <div className="ws-actions">
                      <button
                        className="cp-button"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            setSourcePreview(
                              (await api<{ content: string }>(`connections/${c.id}`)).content,
                            );
                          })
                        }
                      >
                        Read content
                      </button>
                      <button
                        className="cp-button"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await api(`connections/${c.id}/refresh`, {});
                          })
                        }
                      >
                        Refresh
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await api(`connections/${c.id}`, undefined, "DELETE");
                            setSourcePreview("");
                          })
                        }
                      >
                        Revoke
                      </button>
                    </div>
                  )}
                </article>
              ))}
              {sourcePreview && (
                <div className="ws-card">
                  <button onClick={() => setSourcePreview("")}>Close source</button>
                  <pre>{sourcePreview}</pre>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
export function LiveWorkspaceServices({
  view,
  accountId,
}: {
  view: View;
  accountId: string | null;
}) {
  const t = useT();
  if (!accountId)
    return (
      <section className="cp-page ws-services">
        <h1>{t(view === "chapters" ? "Chapters" : view === "agents" ? "Agents" : "Connections")}</h1>
        <p>{t("Sign in from Account to use this workspace.")}</p>
      </section>
    );
  return <Services key={`${accountId}:${view}`} view={view} accountId={accountId} />;
}
