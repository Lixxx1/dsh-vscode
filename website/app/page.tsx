import { MotionLayer } from "./motion-layer";

const marketplaceUrl =
  "https://marketplace.visualstudio.com/items?itemName=lixxx1.dsh-sidebar";
const githubUrl = "https://github.com/Lixxx1/dsh-vscode";

export default function Home() {
  return (
    <main>
      <MotionLayer />
      <div className="scroll-progress" aria-hidden="true" />

      <header className="site-header">
        <a className="brand" href="#top" aria-label="DSH Sidebar home">
          <span className="brand-mark">
            <img src="./deepseek.svg" alt="" />
          </span>
          <span>DSH / SIDEBAR</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#capabilities">Capabilities</a>
          <a href="#workflow">Workflow</a>
          <a href={githubUrl} target="_blank" rel="noreferrer">GitHub ↗</a>
        </nav>
        <a className="nav-cta" href={marketplaceUrl} target="_blank" rel="noreferrer">
          <span>Get extension</span>
          <b aria-hidden="true">↗</b>
        </a>
      </header>

      <section className="hero" id="top">
        <div className="pointer-aura" aria-hidden="true" />
        <div className="hero-grid" aria-hidden="true" />
        <div className="hero-whale" aria-hidden="true">
          <img src="./deepseek.svg" alt="" />
        </div>

        <div className="hero-meta reveal">
          <span>Community-built</span>
          <span>VS Code extension</span>
          <span>2026 / 001</span>
        </div>

        <div className="hero-title-wrap reveal">
          <p className="hero-kicker"><i /> Project-aware coding agent</p>
          <h1>
            <span>DeepSeek Harness</span>
            <span className="hero-outline">inside VS Code.</span>
          </h1>
        </div>

        <div className="hero-bottom reveal">
          <p>
            The official DSH runtime, reimagined for the place where you
            already read, write, run, and review code.
          </p>
          <div className="hero-actions">
            <a className="button button--electric" href={marketplaceUrl} target="_blank" rel="noreferrer">
              Install from Marketplace <span>↗</span>
            </a>
            <a className="button button--dark" href={githubUrl} target="_blank" rel="noreferrer">
              Explore the source <span>→</span>
            </a>
          </div>
        </div>

        <div className="product-scene reveal">
          <div className="scene-label scene-label--one" aria-hidden="true">
            <span>01</span> Current workspace
          </div>
          <div className="scene-label scene-label--two" aria-hidden="true">
            <span>02</span> Native review
          </div>
          <div className="scene-orbit scene-orbit--one" aria-hidden="true" />
          <div className="scene-orbit scene-orbit--two" aria-hidden="true" />
          <div className="editor-window">
            <div className="window-bar">
              <span className="window-dots"><i /><i /><i /></span>
              <span>dsh-vscode-demo</span>
              <span className="window-status"><i /> DSH connected</span>
            </div>
            <div className="window-media">
              <img
                src="./demo.gif"
                alt="DeepSeek Harness editing and reviewing code inside the VS Code sidebar"
              />
            </div>
          </div>
          <div className="scene-toast scene-toast--top" aria-hidden="true">
            <span className="toast-icon">@</span>
            <span><b>Selection attached</b><small>random_number.py · 12–26</small></span>
          </div>
          <div className="scene-toast scene-toast--bottom" aria-hidden="true">
            <span className="toast-icon toast-icon--green">✓</span>
            <span><b>Checks passed</b><small>Ready for review</small></span>
          </div>
        </div>

        <a className="scroll-cue" href="#manifesto">
          <span>Scroll to explore</span>
          <i aria-hidden="true" />
        </a>
      </section>

      <div className="ticker" aria-hidden="true">
        <div className="ticker-track">
          <span>CONTEXT <i>✦</i> CONTROL <i>✦</i> REVIEW <i>✦</i> EXTEND <i>✦</i> STAY IN FLOW <i>✦</i></span>
          <span>CONTEXT <i>✦</i> CONTROL <i>✦</i> REVIEW <i>✦</i> EXTEND <i>✦</i> STAY IN FLOW <i>✦</i></span>
        </div>
      </div>

      <section className="manifesto" id="manifesto">
        <div className="manifesto-index reveal">/ WHY</div>
        <div className="manifesto-copy reveal">
          <p className="section-kicker">No context switching</p>
          <h2>Your coding agent belongs where your code lives.</h2>
        </div>
        <div className="manifesto-aside reveal">
          <p>
            DSH Sidebar keeps DeepSeek Harness beside your editor, carrying the
            workspace, file, selection, permissions, and changes through one
            continuous development loop.
          </p>
          <a href="https://github.com/deepseek-ai/deepseek-harness" target="_blank" rel="noreferrer">
            Built on the official DSH runtime <span>↗</span>
          </a>
        </div>
      </section>

      <section className="capabilities" id="capabilities">
        <div className="capabilities-head reveal">
          <span className="section-index">02 / 05</span>
          <p className="section-kicker">The development loop</p>
          <h2>From intent<br />to reviewed code.</h2>
          <p className="head-note">Four surfaces. One focused workspace.</p>
        </div>

        <article className="capability capability--context reveal">
          <div className="capability-copy">
            <span className="cap-number">01</span>
            <p className="section-kicker">Context</p>
            <h3>It starts exactly where you are.</h3>
            <p>
              Your active workspace, file, and selected lines arrive with the
              prompt. Use @ to bring in anything else with precision.
            </p>
            <ul>
              <li>Active file + selection</li>
              <li>@file and @folder</li>
              <li>Dirty buffer protection</li>
            </ul>
          </div>
          <div className="capability-visual context-visual" aria-hidden="true">
            <div className="visual-topline"><span>ATTACHED CONTEXT</span><span>3 ITEMS</span></div>
            <div className="context-file context-file--active">
              <span className="file-type">PY</span>
              <span><b>random_number.py</b><small>Lines 12–26 · selected</small></span>
              <i>×</i>
            </div>
            <div className="context-file">
              <span className="file-type file-type--folder">/</span>
              <span><b>dsh-vscode-demo</b><small>Current workspace</small></span>
              <i>×</i>
            </div>
            <div className="context-editor">
              <span className="editor-prompt">Review the selected function and fix the edge case</span>
              <span className="editor-caret" />
              <div className="editor-toolbar"><span>+</span><span>@</span><span>/</span><b>↑</b></div>
            </div>
            <div className="context-coordinate">12:26</div>
          </div>
        </article>

        <article className="capability capability--control reveal">
          <div className="capability-copy">
            <span className="cap-number">02</span>
            <p className="section-kicker">Control</p>
            <h3>Give DSH exactly the room it needs.</h3>
            <p>
              Permission, Plan, Model, and Reasoning Effort stay visible at the
              point of action—not hidden in a settings page.
            </p>
            <ul>
              <li>Read only / Workspace / Full access</li>
              <li>Normal and Plan modes</li>
              <li>Independent model + effort</li>
            </ul>
          </div>
          <div className="capability-visual control-visual" aria-hidden="true">
            <div className="control-scanline" />
            <div className="permission-menu">
              <div className="menu-head"><span>PERMISSION MODE</span><small>ESC</small></div>
              <div className="permission-row"><i>○</i><span><b>Read only</b><small>Inspect without writing</small></span></div>
              <div className="permission-row permission-row--active"><i>●</i><span><b>Workspace</b><small>Write inside this project</small></span><em>CURRENT</em></div>
              <div className="permission-row"><i>○</i><span><b>Full access</b><small>Access outside workspace</small></span></div>
            </div>
            <div className="mode-strip"><span>PLAN <b>OFF</b></span><span>MODEL <b>V4</b></span><span>EFFORT <b>MAX</b></span></div>
          </div>
        </article>

        <article className="capability capability--review reveal">
          <div className="capability-copy">
            <span className="cap-number">03</span>
            <p className="section-kicker">Review</p>
            <h3>Every change stays inspectable.</h3>
            <p>
              Changed files are grouped by turn and opened in VS Code’s native
              Diff Editor. Keep or safely revert from the same place.
            </p>
            <ul>
              <li>Native side-by-side diff</li>
              <li>Per-turn +/- line counts</li>
              <li>Keep or safe revert</li>
            </ul>
          </div>
          <div className="capability-visual review-visual" aria-hidden="true">
            <div className="diff-tabs"><span>random_number.py</span><span>Changed files · 1</span></div>
            <div className="diff-columns">
              <div className="diff-column">
                <div><i>7</i><span>return random.randrange(</span></div>
                <div className="code-remove"><i>8</i><span>start, end)</span></div>
                <div><i>9</i><span>&nbsp;</span></div>
                <div><i>10</i><span>values = [random_number(</span></div>
              </div>
              <div className="diff-column">
                <div><i>7</i><span>return random.randint(</span></div>
                <div className="code-add"><i>8</i><span>start, end)</span></div>
                <div><i>9</i><span>&nbsp;</span></div>
                <div className="code-add"><i>10</i><span>assert start &lt;= end</span></div>
              </div>
            </div>
            <div className="review-bar"><span><b>+12</b> <i>−2</i></span><span>OPEN DIFF&nbsp;&nbsp; KEEP&nbsp;&nbsp; REVERT</span></div>
          </div>
        </article>

        <article className="capability capability--extend reveal">
          <div className="capability-copy">
            <span className="cap-number">04</span>
            <p className="section-kicker">Extend</p>
            <h3>Turn DSH into your own harness.</h3>
            <p>
              Discover and install community capabilities directly into the
              official web profile, then let DSH load them after restart.
            </p>
            <ul>
              <li>Tools + Skills</li>
              <li>MCP + Memory</li>
              <li>Agent Hooks</li>
            </ul>
          </div>
          <div className="capability-visual extend-visual" aria-hidden="true">
            <div className="plugin-grid-lines" />
            <span className="plugin-node plugin-node--core"><img src="./deepseek.svg" alt="" /><b>DSH</b></span>
            <span className="plugin-node plugin-node--tools"><i>01</i><b>TOOLS</b></span>
            <span className="plugin-node plugin-node--skills"><i>02</i><b>SKILLS</b></span>
            <span className="plugin-node plugin-node--mcp"><i>03</i><b>MCP</b></span>
            <span className="plugin-node plugin-node--memory"><i>04</i><b>MEMORY</b></span>
            <span className="plugin-node plugin-node--hooks"><i>05</i><b>HOOKS</b></span>
            <span className="plugin-line plugin-line--one" />
            <span className="plugin-line plugin-line--two" />
            <span className="plugin-line plugin-line--three" />
            <span className="plugin-line plugin-line--four" />
            <span className="plugin-line plugin-line--five" />
          </div>
        </article>
      </section>

      <section className="workflow" id="workflow">
        <div className="workflow-head reveal">
          <span className="section-index">03 / 05</span>
          <p className="section-kicker">A smaller loop</p>
          <h2>Open.<br />Ask.<br />Review.</h2>
        </div>
        <ol className="workflow-steps">
          <li className="reveal">
            <span className="step-number">01</span>
            <div className="step-icon">project/</div>
            <h3>Open the workspace</h3>
            <p>DSH starts in the project you trust and sees the file you are actually working on.</p>
          </li>
          <li className="reveal">
            <span className="step-number">02</span>
            <div className="step-icon step-icon--prompt">Fix the edge case ↵</div>
            <h3>Ask in context</h3>
            <p>Attach what matters, choose the operating mode, and let the official runtime work.</p>
          </li>
          <li className="reveal">
            <span className="step-number">03</span>
            <div className="step-icon step-icon--check">+12&nbsp;&nbsp; −2&nbsp;&nbsp; ✓</div>
            <h3>Review the result</h3>
            <p>Follow tools as they run, inspect the native diff, and decide what stays.</p>
          </li>
        </ol>
      </section>

      <section className="final-cta reveal">
        <div className="cta-grid" aria-hidden="true" />
        <div className="cta-whale" aria-hidden="true"><img src="./deepseek.svg" alt="" /></div>
        <span className="section-index">04 / 05</span>
        <p className="section-kicker">Stay in your flow</p>
        <h2>Keep the editor.<br /><span>Add the harness.</span></h2>
        <p>DeepSeek Harness is one sidebar away from your next coding session.</p>
        <div className="hero-actions hero-actions--centered">
          <a className="button button--white" href={marketplaceUrl} target="_blank" rel="noreferrer">
            Install for VS Code <span>↗</span>
          </a>
          <a className="button button--blue-ghost" href={githubUrl} target="_blank" rel="noreferrer">
            Star on GitHub <span>☆</span>
          </a>
        </div>
      </section>

      <footer>
        <a className="brand" href="#top">
          <span className="brand-mark"><img src="./deepseek.svg" alt="" /></span>
          <span>DSH / SIDEBAR</span>
        </a>
        <p>DeepSeek Harness, right beside your code.</p>
        <div className="footer-links">
          <a href={githubUrl}>GitHub ↗</a>
          <a href={marketplaceUrl}>Marketplace ↗</a>
          <a href={`${githubUrl}/blob/main/LICENSE`}>MIT</a>
        </div>
      </footer>
    </main>
  );
}
