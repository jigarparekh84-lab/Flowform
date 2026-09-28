import { useMemo, useState, type FormEvent } from 'react'
import {
  commentsForScenario,
  formatCommentWhen,
} from '../data/collaboration'
import { useFlowform } from '../state/FlowformContext'

type Props = {
  /** Override scenario; defaults to Active. */
  scenarioId?: string
  compact?: boolean
}

export function CommentsPanel({ scenarioId, compact }: Props) {
  const {
    scenarios,
    activeScenarioId,
    comments,
    addScenarioComment,
    deleteScenarioComment,
  } = useFlowform()

  const [threadId, setThreadId] = useState(scenarioId ?? activeScenarioId)
  const [author, setAuthor] = useState('You')
  const [body, setBody] = useState('')

  const effectiveId = scenarioId ?? threadId

  const thread = useMemo(
    () => commentsForScenario(comments, effectiveId),
    [comments, effectiveId],
  )

  const scenarioName =
    scenarios.find((s) => s.id === effectiveId)?.name ?? effectiveId

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!body.trim()) return
    addScenarioComment(effectiveId, body, author)
    setBody('')
  }

  return (
    <section
      className={compact ? 'comments-panel compact' : 'comments-panel'}
      aria-label="Scenario comments"
    >
      <div className="comments-head">
        <h2>Comments</h2>
        {!scenarioId && (
          <label className="field inline-field">
            <span>Thread</span>
            <select
              value={effectiveId}
              onChange={(e) => setThreadId(e.target.value)}
            >
              {scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {scenarioId && (
          <p className="muted tiny">Thread · {scenarioName}</p>
        )}
      </div>

      <ul className="comments-list">
        {thread.length === 0 && (
          <li className="muted tiny">No comments yet on this scenario.</li>
        )}
        {thread.map((c) => (
          <li key={c.id} className="comment-item">
            <div className="comment-meta">
              <strong>{c.author}</strong>
              <span className="muted tiny">{formatCommentWhen(c.createdAt)}</span>
              <button
                type="button"
                className="btn ghost sm comment-del"
                onClick={() => deleteScenarioComment(c.id)}
                title="Delete comment"
              >
                ✕
              </button>
            </div>
            <p>{c.body}</p>
          </li>
        ))}
      </ul>

      <form className="comments-compose" onSubmit={submit}>
        <label className="field">
          <span>Author</span>
          <input
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="Your name"
          />
        </label>
        <label className="field">
          <span>Comment</span>
          <textarea
            rows={compact ? 2 : 3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Note for collaborators…"
          />
        </label>
        <button type="submit" className="btn primary sm" disabled={!body.trim()}>
          Add comment
        </button>
      </form>
    </section>
  )
}
