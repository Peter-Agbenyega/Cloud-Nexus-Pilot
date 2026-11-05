"use client";

import { useState } from "react";
import styles from "./copilot-reading-panels.module.css";

export type CopilotReadingAnswer = {
  speakNow: string;
  keyPoints: string[];
  fullAnswer: string;
  headline?: string;
  caution?: string | null;
  followUp?: string | null;
};

export type CopilotReadingPanelsProps = {
  question: string;
  hearingText?: string;
  answer: CopilotReadingAnswer | null;
  preview: string;
  status: "idle" | "loading" | "ready" | "failed";
  error?: string;
  firstTextMs?: number | null;
  onRetry?: () => void;
  canRetry?: boolean;
};

export function CopilotReadingPanels({
  question, hearingText = "", answer, preview, status, error,
  firstTextMs = null, onRetry, canRetry = false,
}: CopilotReadingPanelsProps) {
  const [textSize, setTextSize] = useState<"comfortable" | "large">("comfortable");
  const completedAnswer = status === "loading" || status === "failed" ? null : answer;
  const streamingText = status === "loading" ? preview : "";
  const opening = completedAnswer?.speakNow || streamingText;
  const answerState = status === "failed" ? "Needs attention" : status === "loading"
    ? streamingText ? "Writing answer" : "Preparing answer"
    : completedAnswer ? "Complete" : "Ready";
  const hasTiming = typeof firstTextMs === "number" && Number.isFinite(firstTextMs) && firstTextMs >= 0;

  return (
    <section className={styles.workspace} data-text-size={textSize} aria-label="Question and answer workspace">
      <div className={styles.toolbar}>
        <p className={styles.workspaceLabel}>Your conversation, in focus</p>
        <div className={styles.textControls} role="group" aria-label="Reading text size">
          <span>Text size</span>
          <button type="button" aria-label="Comfortable text size" aria-pressed={textSize === "comfortable"}
            onClick={() => setTextSize("comfortable")}>A</button>
          <button type="button" aria-label="Larger text size" aria-pressed={textSize === "large"}
            onClick={() => setTextSize("large")}>A<span className={styles.plus}>+</span></button>
        </div>
      </div>

      <div className={styles.grid}>
        <section className={`${styles.panel} ${styles.questionPanel}`} aria-label="Question panel">
          <header className={styles.panelHeader}>
            <h2><span className={styles.number} aria-hidden="true">01</span> Question</h2>
            <span className={`${styles.badge} ${styles.questionBadge}`}>
              {question ? "Current question" : hearingText ? "Listening" : "Ready"}
            </span>
          </header>
          <div className={`${styles.panelBody} ${styles.questionBody}`} tabIndex={0} aria-label="Question reading area">
            {question ? <p className={styles.question}>{question}</p>
              : hearingText ? <>
                <p className={styles.eyebrow}>Hearing your question</p>
                <p className={`${styles.question} ${styles.hearing}`}>{hearingText}</p>
                <p className={styles.supporting}>Waiting for the rest of the question…</p>
              </> : <div className={styles.empty}>
                <span className={styles.quoteMark} aria-hidden="true">“</span>
                <p className={styles.emptyTitle}>Your question goes here.</p>
                <p className={styles.supporting}>Speak or type a question. It stays beside the answer while you read.</p>
              </div>}
          </div>
          <footer className={styles.panelFooter}>
            <span className={styles.questionDot} aria-hidden="true" />
            {question ? "Question in focus" : hearingText ? "Speech is arriving" : "Ready for your next question"}
          </footer>
        </section>

        <section className={`${styles.panel} ${styles.answerPanel}`} aria-label="Answer panel">
          <header className={styles.panelHeader}>
            <h2><span className={styles.number} aria-hidden="true">02</span> Answer</h2>
            <span role="status" className={`${styles.badge} ${status === "failed" ? styles.errorBadge : styles.answerBadge}`}>{answerState}</span>
          </header>
          <div className={styles.panelBody} tabIndex={0} aria-label="Answer reading area" aria-busy={status === "loading"}>
            {status === "failed" ? <div className={styles.empty}>
              <p className={styles.emptyTitle}>The answer could not finish.</p>
              <p className={styles.error}>{error || "Your question is still here. Try generating its answer again."}</p>
              {canRetry && onRetry ? <button type="button" className={styles.retryButton} onClick={onRetry}>Try again</button> : null}
            </div> : opening ? <>
              <p className={styles.eyebrow}>{completedAnswer ? "Start with this" : "Answer arriving · not yet saved"}</p>
              <p className={styles.opening}>{opening}</p>
              {completedAnswer && completedAnswer.keyPoints.length > 0 ? <div className={styles.points}>
                <h3>Key points</h3>
                <ul>{completedAnswer.keyPoints.slice(0, 3).map((point, index) => <li key={`${index}-${point}`}>{point}</li>)}</ul>
              </div> : null}
              {completedAnswer && (completedAnswer.fullAnswer || completedAnswer.caution || completedAnswer.followUp) ?
                <details className={styles.more} key={question}>
                  <summary>Read the full answer <span aria-hidden="true">↗</span></summary>
                  {completedAnswer.fullAnswer ? <p className={styles.fullAnswer}>{completedAnswer.fullAnswer}</p> : null}
                  {completedAnswer.caution ? <p className={styles.detailNote}><strong>Keep in mind</strong>{completedAnswer.caution}</p> : null}
                  {completedAnswer.followUp ? <p className={styles.detailNote}><strong>Possible follow-up</strong>{completedAnswer.followUp}</p> : null}
                </details> : null}
            </> : <div className={styles.empty}>
              <span className={styles.answerSymbol} aria-hidden="true">↗</span>
              <p className={styles.emptyTitle}>{status === "loading" ? "Preparing your answer…" : "A clear answer, right here."}</p>
              <p className={styles.supporting}>{status === "loading"
                ? "The opening words will appear as they arrive."
                : "Read the opening response first, then explore the key points and full explanation."}</p>
            </div>}
          </div>
          <footer className={styles.panelFooter}>
            <span className={styles.answerDot} aria-hidden="true" />
            <span>{status === "loading" ? "Draft · still generating" : completedAnswer ? "Completed answer" : status === "failed" ? "Question preserved" : "Ready to help you respond"}</span>
            {hasTiming && (opening || completedAnswer) ? <span className={styles.timing}>First text · {(firstTextMs / 1000).toFixed(1)}s</span> : null}
          </footer>
        </section>
      </div>
    </section>
  );
}
