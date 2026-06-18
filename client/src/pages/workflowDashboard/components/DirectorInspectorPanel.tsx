 import { useEffect, useMemo, useState } from 'react'; 
 import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'; 
 import { Badge } from '@/components/ui/badge'; 
 import { Button } from '@/components/ui/button'; 
 import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'; 
 import { toast } from '@/components/ui/toast'; 
 import { cn } from '@/lib/utils'; 
 import { queryKeys } from '@/api/queryKeys'; 
 import { 
   getDirectorInspectorSnapshot, 
   getDirectorInspectorLocks, 
   releaseDirectorInspectorLock, 
   type DirectorInspectorSnapshot, 
   type InspectorLockRow, 
 } from '@/api/workflow/inspector'; 
 
 const POLL_STORAGE_KEY = 'aicockpit-inspector-poll-ms'; 
 const DEFAULT_POLL_MS = 5000; 
 const FAST_POLL_MS = 10000; 
 const MIN_POLL_MS = 2000; 
 const MAX_POLL_MS = 60000; 
 
 function readStoredPollMs(): number { 
   if (typeof window === 'undefined') return DEFAULT_POLL_MS; 
   const raw = window.localStorage.getItem(POLL_STORAGE_KEY); 
   if (!raw) return DEFAULT_POLL_MS; 
   const n = Number(raw); 
   if (!Number.isFinite(n)) return DEFAULT_POLL_MS; 
   return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.round(n))); 
 } 
 
 function persistPollMs(value: number): void { 
   if (typeof window === 'undefined') return; 
   window.localStorage.setItem(POLL_STORAGE_KEY, String(value)); 
 } 
 
 function formatRelative(value: string | null | undefined): string { 
   if (!value) return ''; 
   const t = new Date(value).getTime(); 
   if (Number.isNaN(t)) return ''; 
   const delta = Date.now() - t; 
   if (delta < 0) return '即将'; 
   const s = Math.floor(delta / 1000); 
   if (s < 60) return s + ' 秒前'; 
   const m = Math.floor(s / 60); 
   if (m < 60) return m + ' 分前'; 
   const h = Math.floor(m / 60); 
   return h + ' 小时前'; 
 } 
 
 function formatRemaining(ms: number): string { 
   if (ms <= 0) return '已过期'; 
   const s = Math.floor(ms / 1000); 
   if (s < 60) return s + ' 秒'; 
   const m = Math.floor(s / 60); 
   const ss = s % 60; 
   return m + ' 分 ' + ss + ' 秒'; 
 } 
 
 function formatDuration(ms: number | null): string { 
   if (ms === null) return ''; 
   if (ms < 1000) return ms + 'ms'; 
   const s = Math.floor(ms / 1000); 
   if (s < 60) return s + 's'; 
   const m = Math.floor(s / 60); 
   return m + 'm' + (s % 60) + 's'; 
 } 
 
 function statusLabel(status: string): { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' } { 
   switch (status) { 
     case 'succeeded': return { label: '成功', variant: 'outline' }; 
     case 'failed': return { label: '失败', variant: 'destructive' }; 
     case 'running': return { label: '运行中', variant: 'default' }; 
     case 'queued': return { label: '排队', variant: 'secondary' }; 
     case 'waiting_approval': return { label: '等待审核', variant: 'secondary' }; 
     case 'cancelled': return { label: '已取消', variant: 'outline' }; 
     default: return { label: status, variant: 'outline' }; 
   } 
 } 
  function PollControl({ value, onChange }: { value: number; onChange: (n: number) => void; }) { 
   const [customRaw, setCustomRaw] = useState(''); 
   return ( 
     <div className='flex flex-wrap items-center gap-2 text-xs'> 
       <span className='text-muted-foreground'>轮询</span> 
       <div className='inline-flex rounded-md border border-border bg-card'> 
         {[DEFAULT_POLL_MS, FAST_POLL_MS].map((preset) => ( 
           <button 
             key={preset} 
             type='button' 
             className={cn( 
               'px-2 py-1 text-xs', 
               value === preset ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted', 
             )} 
             onClick={() => onChange(preset)} 
           > 
             {preset / 1000}s 
           </button> 
         ))} 
       </div> 
       <input 
         type='number' 
         inputMode='numeric' 
         min={MIN_POLL_MS} 
         max={MAX_POLL_MS} 
         step={1000} 
         placeholder='自定义' 
         value={customRaw} 
         onChange={(e) => setCustomRaw(e.target.value)} 
         className='h-7 w-24 rounded-md border border-border bg-card px-2 text-xs' 
       /> 
       <Button 
         size='sm' 
         variant='outline' 
         onClick={() => { 
           const n = Number(customRaw); 
           if (!Number.isFinite(n)) { 
             toast.error('请输入有效数字'); 
             return; 
           } 
           const clamped = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.round(n))); 
           setCustomRaw(String(clamped)); 
           onChange(clamped); 
         }} 
       > 
         应用 
       </Button> 
     </div> 
   ); 
 } 
  function ConfirmReleaseDialog({ lock, onCancel, onConfirm, isPending }: { lock: any; onCancel: () => void; onConfirm: () => void; isPending: boolean; }) { 
   return ( 
     <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4'> 
       <Card className='w-full max-w-md'> 
         <CardHeader> 
           <CardTitle>确认释放这条死锁</CardTitle> 
           <CardDescription>仅当 owner 任务已 finished 时才允许释放</CardDescription> 
         </CardHeader> 
         <CardContent className='space-y-3 text-sm'> 
           <div> 
             <div className='text-muted-foreground'>key</div> 
             <div className='font-mono text-xs break-all'>{lock.key}</div> 
           </div> 
           <div className='grid grid-cols-2 gap-2'> 
             <div> 
               <div className='text-muted-foreground'>owner</div> 
               <div className='font-mono text-xs break-all'>{lock.ownerId ?? '(无)'}</div> 
             </div> 
             <div> 
               <div className='text-muted-foreground'>owner task status</div> 
               <div className='text-xs'>{lock.ownerTaskStatus ?? '未知'}</div> 
             </div> 
             <div> 
               <div className='text-muted-foreground'>scope</div> 
               <div className='text-xs'>{lock.scope ?? '(无)'}</div> 
             </div> 
             <div> 
               <div className='text-muted-foreground'>剩余</div> 
               <div className='text-xs'>{formatRemaining(lock.remainingMs)}</div> 
             </div> 
           </div> 
           <div className='rounded-md border border-border bg-muted/40 p-2 text-xs text-muted-foreground'> 
             释放后: 你可以立即重新入队章节标题修复命令;不会影响任何正在跑的命令;如果你点了重试任务,系统会自动重新拿锁。 
           </div> 
           <div className='flex justify-end gap-2'> 
             <Button variant='outline' size='sm' onClick={onCancel} disabled={isPending}>取消</Button> 
             <Button variant='destructive' size='sm' onClick={onConfirm} disabled={isPending}> 
               {isPending ? '释放中…' : '确认释放'} 
             </Button> 
           </div> 
         </CardContent> 
       </Card> 
     </div> 
   ); 
 } 
  export default function DirectorInspectorPanel({ novelId, novelTitle, onClose }: { novelId: string; novelTitle?: string; onClose?: () => void; }) { 
   const [pollMs, setPollMs] = useState<number>(() => readStoredPollMs()); 
   useEffect(() => { persistPollMs(pollMs); }, [pollMs]); 
   const queryClient = useQueryClient(); 
   const [confirmLock, setConfirmLock] = useState<InspectorLockRow | null>(null); 
 
   const snapshotQuery = useQuery({ 
     queryKey: queryKeys.novels.directorInspector(novelId), 
     queryFn: () => getDirectorInspectorSnapshot(novelId), 
     refetchInterval: pollMs, 
     enabled: Boolean(novelId), 
   }); 
   const locksQuery = useQuery({ 
     queryKey: queryKeys.novels.directorInspectorLocks(novelId), 
     queryFn: () => getDirectorInspectorLocks(novelId), 
     refetchInterval: pollMs, 
     enabled: Boolean(novelId), 
   }); 
 
   const releaseMutation = useMutation({ 
     mutationFn: (key: string) => releaseDirectorInspectorLock({ key, novelId }), 
     onSuccess: async (data) => { 
       if (data?.success && data.data?.released) { 
         toast.success('锁已释放'); 
         setConfirmLock(null); 
         await queryClient.invalidateQueries({ queryKey: queryKeys.novels.directorInspector(novelId) }); 
         await queryClient.invalidateQueries({ queryKey: queryKeys.novels.directorInspectorLocks(novelId) }); 
       } else { 
         toast.error('释放失败: ' + (data?.message ?? '未知原因')); 
       } 
     }, 
     onError: (error) => { 
       const message = error instanceof Error ? error.message : '释放失败'; 
       toast.error(message); 
     }, 
   }); 
 
   const snapshot: DirectorInspectorSnapshot | null = snapshotQuery.data?.data ?? null; 
   const isLoading = snapshotQuery.isPending; 
   const error = snapshotQuery.error; 
 
   const inFlight = snapshot?.inFlightCommands ?? []; 
   const waiting = snapshot?.waitingCommands ?? []; 
   const recent = snapshot?.recentCommands ?? []; 
   const locks = snapshot?.activeLocks ?? []; 
   const executions = snapshot?.recentExecutions ?? []; 
 
   const lockSummary = useMemo(() => { 
     if (locks.length === 0) return { label: '空', variant: 'outline' as const }; 
     const releasable = locks.filter((l) => l.canSafelyRelease).length; 
     if (releasable > 0) return { label: releasable + ' 把可释放', variant: 'destructive' as const }; 
     return { label: locks.length + ' 把占用中', variant: 'default' as const }; 
   }, [locks]); 
 
   return ( 
     <div className='mt-3 space-y-3 rounded-lg border border-border bg-muted/30 p-3'> 
       <div className='flex flex-wrap items-center justify-between gap-2'> 
         <div> 
           <div className='text-sm font-medium'>Runtime 详情 {novelTitle ? '· ' + novelTitle : ''}</div> 
           <div className='text-xs text-muted-foreground'>novel/{novelId}</div> 
         </div> 
         <div className='flex flex-wrap items-center gap-2'> 
           <PollControl value={pollMs} onChange={setPollMs} /> 
           {onClose ? <Button size='sm' variant='outline' onClick={onClose}>收起</Button> : null} 
         </div> 
       </div> 
 
       {error ? ( 
         <Card> 
           <CardHeader> 
             <CardTitle className='text-destructive'>无法读取 runtime 状态</CardTitle> 
             <CardDescription>{error instanceof Error ? error.message : '请检查后端'}</CardDescription> 
           </CardHeader> 
         </Card> 
       ) : null} 
 
       <div className='grid gap-3 md:grid-cols-2'> 
         <Card> 
           <CardHeader className='pb-2'> 
             <CardDescription>正在跑的命令</CardDescription> 
             <CardTitle className='text-base'>{inFlight.length} 条</CardTitle> 
           </CardHeader> 
           <CardContent className='space-y-1 text-xs'> 
             {inFlight.length === 0 ? <div className='text-muted-foreground'>没有正在跑的命令</div> : inFlight.map((c) => ( 
               <div key={c.id} className='flex flex-wrap items-center gap-2'> 
                 <Badge {...statusLabel(c.status)}>{statusLabel(c.status).label}</Badge> 
                 <span className='font-mono'>{c.commandType}</span> 
                 <span className='text-muted-foreground'>attempt={c.attempt}</span> 
                 <span className='text-muted-foreground'>{formatRelative(c.startedAt)}</span> 
               </div> 
             ))} 
           </CardContent> 
         </Card> 
 
         <Card> 
           <CardHeader className='pb-2'> 
             <CardDescription>等待中的命令</CardDescription> 
             <CardTitle className='text-base'>{waiting.length} 条</CardTitle> 
           </CardHeader> 
           <CardContent className='space-y-1 text-xs'> 
             {waiting.length === 0 ? <div className='text-muted-foreground'>队列是空的</div> : waiting.map((c) => ( 
               <div key={c.id} className='flex flex-wrap items-center gap-2'> 
                 <Badge {...statusLabel(c.status)}>{statusLabel(c.status).label}</Badge> 
                 <span className='font-mono'>{c.commandType}</span> 
                 <span className='text-muted-foreground'>priority={c.priority}</span> 
                 {c.runAfter ? <span className='text-muted-foreground'>runAfter={formatRelative(c.runAfter)}</span> : null} 
               </div> 
             ))} 
           </CardContent> 
         </Card> 
 
         <Card> 
           <CardHeader className='pb-2'> 
             <CardDescription>高内存锁状态</CardDescription> 
             <CardTitle className='text-base'> 
               <Badge variant={lockSummary.variant}>{lockSummary.label}</Badge> 
             </CardTitle> 
           </CardHeader> 
           <CardContent className='space-y-2 text-xs'> 
             {locks.length === 0 ? <div className='text-muted-foreground'>当前没有任何高内存锁</div> : locks.map((lock) => ( 
               <div key={lock.key} className='rounded-md border border-border bg-card p-2'> 
                 <div className='flex flex-wrap items-center justify-between gap-2'> 
                   <div className='font-mono text-[10px] break-all'>{lock.key}</div> 
                   <div className='text-muted-foreground'>剩余 {formatRemaining(lock.remainingMs)}</div> 
                 </div> 
                 <div className='mt-1 grid grid-cols-2 gap-1 text-[11px]'> 
                   <div>owner: <span className='font-mono'>{lock.ownerId ?? '(无)'}</span></div> 
                   <div>scope: {lock.scope ?? '(无)'}</div> 
                   <div>owner task status: {lock.ownerTaskStatus ?? '未知'}</div> 
                   <div>acquired: {formatRelative(lock.acquiredAt)}</div> 
                 </div> 
                 {lock.canSafelyRelease ? ( 
                   <div className='mt-2 flex items-center justify-between'> 
                     <div className='text-muted-foreground'>owner 任务已 finished,可以安全释放</div> 
                     <Button size='sm' variant='destructive' onClick={() => setConfirmLock(lock)}>现在释放</Button> 
                   </div> 
                 ) : null} 
               </div> 
             ))} 
           </CardContent> 
         </Card> 
 
         <Card> 
           <CardHeader className='pb-2'> 
             <CardDescription>最近执行</CardDescription> 
             <CardTitle className='text-base'>{executions.length} 条</CardTitle> 
           </CardHeader> 
           <CardContent className='space-y-1 text-xs'> 
             {executions.length === 0 ? <div className='text-muted-foreground'>没有执行历史</div> : executions.slice(0, 8).map((e) => ( 
               <div key={e.id} className='flex flex-wrap items-center gap-2'> 
                 <Badge {...statusLabel(e.status)}>{statusLabel(e.status).label}</Badge> 
                 <span className='font-mono'>{e.stepType ?? e.id.slice(0, 8)}</span> 
                 <span className='text-muted-foreground'>{formatDuration(e.durationMs)}</span> 
                 <span className='text-muted-foreground'>{formatRelative(e.startedAt)}</span> 
                 {e.errorMessage ? <span className='text-destructive truncate max-w-[180px]'>{e.errorMessage}</span> : null} 
               </div> 
             ))} 
           </CardContent> 
         </Card> 
       </div> 
 
       {isLoading ? <div className='text-xs text-muted-foreground'>正在拉取 runtime 状态…</div> : null} 
 
       {confirmLock ? ( 
         <ConfirmReleaseDialog 
           lock={confirmLock} 
           onCancel={() => setConfirmLock(null)} 
           onConfirm={() => releaseMutation.mutate(confirmLock.key)} 
           isPending={releaseMutation.isPending} 
         /> 
       ) : null} 
     </div> 
   ); 
 } 
 