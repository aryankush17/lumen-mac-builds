import type { Component, Editor } from 'grapesjs'

type NativeVideoView = {model:Component;initVideoEl:(element:HTMLVideoElement)=>void}

// GrapesJS renders a separate inner player in its editing canvas. Copy the
// loading/accessibility attributes onto that player as well as the export model.
export function configureNativeVideo(editor:Editor) {
  editor.Components.addType('video', {
    extend: 'video',
    view: {
      renderSource(this:NativeVideoView) {
        const player=document.createElement('video'),attrs=this.model.getAttributes()
        player.preload=String(attrs.preload||'none') as HTMLVideoElement['preload']
        player.playsInline=true
        if(attrs['aria-label'])player.setAttribute('aria-label',String(attrs['aria-label']))
        player.src=String(this.model.get('src')||'')
        this.initVideoEl(player)
        return player
      },
    },
  })
}
