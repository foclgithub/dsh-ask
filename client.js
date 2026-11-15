/**
 * dsh-ask client entry: the settings control for the plugin's `language`
 * Config field.
 *
 * The Host serves this file as a browser script, so it uses the same
 * `window.__ModuleLoader__.load({ id, factory })` wrapper as the installed
 * plugins; `factory(require)` gets React from the Host and returns the client
 * plugin shape `{ inject, apply }`. No build step and no locale package: the
 * one label and the one control are bilingual inline.
 *
 * The control is registered into the plugin manager's `plugins.row.config`
 * slot under the key `<package name>#<row id>`, i.e. the row this plugin's
 * `cordis.patch.yml` inserts (`local-cli`). `slots.inject` waits until the slot
 * owner (the Plugins page) exists, so this entry never races the manager.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-local-cli',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const VALUES = ['auto', 'zh', 'en']
    const LABELS = {
      auto: '自动 / Auto',
      zh: '中文 / Chinese',
      en: 'English / 英文',
    }

    /** Short one-liner shown on the plugin row before the page is opened. */
    function Summary() {
      return React.createElement('span', null, 'dsh-ask 界面语言 / Interface language')
    }

    /**
     * The page body. `form` is the plugin manager's wrapper over the settings
     * form: `state` is its snapshot and `mutate(ops, revision)` is the only
     * write path. The select is uncontrolled by the Host: it starts from
     * `state.value.language` and keeps the user's pending choice locally until
     * Save is pressed.
     */
    function Page(props) {
      const form = props.form
      const [draft, setDraft] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [saving, setSaving] = React.useState(false)
      // A synchronous guard, not state: two clicks in the same frame would both
      // read the old `saving` closure and fire two writes.
      const inFlight = React.useRef(false)

      const state = form === undefined ? undefined : form.state
      const ready = state !== undefined && state.status === 'ready' && state.writable === true
      // The current value is shown even when the setting is read-only: the
      // read path never depends on writability, only the write path does.
      const current = state === undefined ? undefined : state.value?.language
      const value = draft !== null ? draft : VALUES.includes(current) ? current : 'auto'
      const disabled = saving === true || ready !== true

      if (form === undefined) {
        return React.createElement(
          'p',
          { role: 'status' },
          '正在等待设置加载 / Waiting for the setting to load…',
        )
      }

      const save = async () => {
        if (inFlight.current === true) return
        const desired = draft !== null ? draft : current ?? 'auto'
        // Never submit a value outside the schema: an unknown label (a stale
        // bookmark, a DOM edit) is an error on screen, not a write.
        if (VALUES.includes(desired) !== true) {
          setNotice({ kind: 'error', text: '不支持的语言 / Unsupported language' })
          return
        }
        if (disabled === true) return
        inFlight.current = true
        setSaving(true)
        setNotice(null)
        try {
          // ConfigFormController.mutate resolves to a boolean: true only when
          // the Host accepted the write (after any recovery read). false and
          // any unknown shape are failures, never a success.
          const accepted = await form.mutate(
            [{ op: 'set', path: ['language'], value: desired }],
            state.revision,
          )
          if (accepted !== true) throw new Error('the Host did not accept the write')
          setDraft(null)
          setNotice({
            kind: 'saved',
            text: '已保存，下次启动 dsh-ask 生效 / Saved; applies the next time dsh-ask starts',
          })
        } catch (error) {
          // A failed write is reported as a failure, never as a success.
          setNotice({
            kind: 'error',
            text: `保存失败 / Save failed: ${String(error?.message ?? error)}`,
          })
        } finally {
          inFlight.current = false
          setSaving(false)
        }
      }

      const statusLine =
        ready === true
          ? null
          : state?.status === 'ready'
            ? '设置只读 / The setting is read-only.'
            : '设置尚未加载 / The setting is not loaded yet.'

      return React.createElement(
        'div',
        null,
        React.createElement(
          'p',
          null,
          'dsh-ask 界面语言 / Interface language。保存后下次启动 dsh-ask 生效；--lang 与 DSH_ASK_LANG 优先 / It takes effect the next time dsh-ask starts; --lang and DSH_ASK_LANG take precedence.',
        ),
        React.createElement(
          'label',
          null,
          '界面语言 / Interface language: ',
          React.createElement(
            'select',
            {
              value,
              disabled,
              onChange: (event) => {
                setDraft(event.target.value)
                setNotice(null)
              },
            },
            VALUES.map((option) =>
              React.createElement('option', { key: option, value: option }, LABELS[option]),
            ),
          ),
        ),
        React.createElement(
          'button',
          { type: 'button', disabled, onClick: save },
          saving === true ? '保存中… / Saving…' : '保存 / Save',
        ),
        statusLine === null ? null : React.createElement('p', { role: 'status' }, statusLine),
        notice === null
          ? null
          : React.createElement(
              'p',
              { role: notice.kind === 'error' ? 'alert' : 'status' },
              notice.text,
            ),
      )
    }

    /** The slot component: one short row before opening, the form once opened. */
    function Settings(props) {
      return props.view === 'summary' ? Summary() : React.createElement(Page, props)
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('plugins.row.config', () =>
        ctx.slots.register(
          { name: 'plugins.row.config', key: '@local/dsh-local-cli#local-cli' },
          Settings,
        ),
      )
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
