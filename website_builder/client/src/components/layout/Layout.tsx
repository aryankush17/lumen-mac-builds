import { Outlet, useLocation } from 'react-router-dom'
import { motion, useReducedMotion } from 'framer-motion'
import Sidebar from './Sidebar'
import TopBar from './TopBar'
import { useEffect, useState } from 'react'

export default function Layout() {
  const location = useLocation()
  const reducedMotion = useReducedMotion()
  const embedded = window.self !== window.top
  const building = location.pathname === '/build'
  const [editing,setEditing]=useState(false)
  useEffect(()=>{const changed=(event:Event)=>setEditing(Boolean((event as CustomEvent).detail));window.addEventListener('lumen-builder-editing',changed);return()=>window.removeEventListener('lumen-builder-editing',changed)},[])
  return (
    <div className={`flex min-h-screen bg-background ${embedded ? 'lumen-embedded-tools' : ''}`}>
      {!editing && <Sidebar />}
      <div className={editing?'flex-1 flex flex-col min-h-screen':'flex-1 ml-64 flex flex-col min-h-screen'}>
        {!building && <TopBar />}
        <main className={building ? 'flex-1' : 'flex-1 pt-16'}>
          <motion.div key={location.pathname}
            initial={{ opacity: reducedMotion ? 1 : 0, y: reducedMotion ? 0 : 5 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reducedMotion ? 0 : 0.2 }}
            className={editing?'builder-focus-shell w-full':'p-6 max-w-[1400px] mx-auto w-full'}>
            <Outlet />
          </motion.div>
        </main>
      </div>
    </div>
  )
}
