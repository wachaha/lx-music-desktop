import {
  downloadTasksGet,
  // downloadListClear,
  downloadTasksCreate,
  downloadTasksRemove,
  downloadTasksUpdate,
} from '@renderer/utils/ipc'
import {
  downloadList,
} from './state'
import { markRaw, toRaw } from '@common/utils/vueTools'
import { getMusicUrl, getPicUrl, getLyricInfo } from '@renderer/core/music/online'
import { appSetting } from '../setting'
import { qualityList } from '..'
import { proxyCallback } from '@renderer/worker/utils'
import { arrPush, arrUnshift, joinPath } from '@renderer/utils'
import { DOWNLOAD_STATUS } from '@common/constants'

const waitingUpdateTasks = new Map<string, LX.Download.ListItem>()
let timer: NodeJS.Timeout | null = null
const throttleUpdateTask = (tasks: LX.Download.ListItem[]) => {
  for (const task of tasks) waitingUpdateTasks.set(task.id, toRaw(task))
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    void downloadTasksUpdate(Array.from(waitingUpdateTasks.values()))
    waitingUpdateTasks.clear()
  }, 100)
}

const runingTask = new Map<string, LX.Download.ListItem>()

// const initDownloadList = (list: LX.Download.ListItem[]) => {
//   downloadList.splice(0, downloadList.length, ...list)
// }

export const getDownloadList = async(): Promise<LX.Download.ListItem[]> => {
  if (!downloadList.length) {
    const list = await downloadTasksGet()
    for (const downloadInfo of list) {
      markRaw(downloadInfo.metadata)
      switch (downloadInfo.status) {
        case DOWNLOAD_STATUS.RUN:
        case DOWNLOAD_STATUS.WAITING:
          downloadInfo.status = DOWNLOAD_STATUS.PAUSE
          downloadInfo.statusText = window.i18n.t('download___status_paused')
        default:
          break
      }
    }
    arrPush(downloadList, list)
  }
  return downloadList
}

const addTasks = async(list: LX.Download.ListItem[]) => {
  const addMusicLocationType = appSetting['list.addMusicLocationType']

  await downloadTasksCreate(list.map(i => toRaw(i)), addMusicLocationType)

  if (addMusicLocationType === 'top') {
    arrUnshift(downloadList, list)
  } else {
    arrPush(downloadList, list)
  }
  window.app_event.downloadListUpdate()
}

const setStatusText = (downloadInfo: LX.Download.ListItem, text: string) => { // 设置状态文本
  downloadInfo.statusText = text
  throttleUpdateTask([downloadInfo])
}

const setUrl = (downloadInfo: LX.Download.ListItem, url: string) => {
  downloadInfo.metadata.url = url
  throttleUpdateTask([downloadInfo])
}

const updateFilePath = (downloadInfo: LX.Download.ListItem, filePath: string) => {
  downloadInfo.metadata.filePath = filePath
  throttleUpdateTask([downloadInfo])
}

const setProgress = (downloadInfo: LX.Download.ListItem, progress: LX.Download.ProgressInfo) => {
  downloadInfo.progress = progress.progress
  downloadInfo.total = progress.total
  downloadInfo.downloaded = progress.downloaded
  downloadInfo.speed = progress.speed
  throttleUpdateTask([downloadInfo])
}

const setStatus = (downloadInfo: LX.Download.ListItem, status: LX.Download.DownloadTaskStatus, statusText?: string) => { // 设置状态及状态文本
  if (statusText == null) {
    switch (status) {
      case DOWNLOAD_STATUS.RUN:
        statusText = window.i18n.t('download___status_runing')
        break
      case DOWNLOAD_STATUS.WAITING:
        statusText = window.i18n.t('download___status_wating')
        break
      case DOWNLOAD_STATUS.PAUSE:
        statusText = window.i18n.t('download___status_paused')
        break
      case DOWNLOAD_STATUS.ERROR:
        statusText = window.i18n.t('download___status_error')
        break
      case DOWNLOAD_STATUS.COMPLETED:
        statusText = window.i18n.t('download___status_complated')
        break
      default:
        statusText = ''
        break
    }
  }

  if (downloadInfo.statusText == statusText && downloadInfo.status == status) return

  if (status == DOWNLOAD_STATUS.COMPLETED) downloadInfo.isComplate = true
  downloadInfo.statusText = statusText
  downloadInfo.status = status
  throttleUpdateTask([downloadInfo])
}

// 修复 1.1.x版本 酷狗源歌词格式
const fixKgLyric = (lrc: string) => /\[00:\d\d:\d\d.\d+\]/.test(lrc) ? lrc.replace(/(?:\[00:(\d\d:\d\d.\d+\]))/gm, '[$1') : lrc

/**
 * 设置歌曲meta信息
 * @param downloadInfo 下载任务信息
 */
const saveMeta = (downloadInfo: LX.Download.ListItem) => {
  if (downloadInfo.metadata.quality === 'ape') return
  const isUseOtherSource = appSetting['download.isUseOtherSource']
  const tasks: [Promise<string | null>, Promise<LX.Player.LyricInfo | null>] = [
    appSetting['download.isEmbedPic']
      ? downloadInfo.metadata.musicInfo.meta.picUrl
        ? Promise.resolve(downloadInfo.metadata.musicInfo.meta.picUrl)
        : getPicUrl({ musicInfo: downloadInfo.metadata.musicInfo, isRefresh: false, allowToggleSource: isUseOtherSource }).catch(err => {
          console.log(err)
          return null
        })
      : Promise.resolve(null),
    appSetting['download.isEmbedLyric']
      ? getLyricInfo({ musicInfo: downloadInfo.metadata.musicInfo, isRefresh: false, allowToggleSource: isUseOtherSource }).catch(err => {
        console.log(err)
        return null
      })
      : Promise.resolve(null),
  ]
  void Promise.all(tasks).then(([imgUrl, lyrics]) => {
    if (lyrics?.lyric) lyrics.lyric = fixKgLyric(lyrics.lyric)
    void window.lx.worker.download.writeMeta(downloadInfo.metadata.filePath, {
      title: downloadInfo.metadata.musicInfo.name,
      artist: downloadInfo.metadata.musicInfo.singer,
      album: downloadInfo.metadata.musicInfo.meta.albumName,
      APIC: imgUrl,
      lyrics: lyrics?.lyric ?? null,
    })
  })
}

/**
 * 保存歌词文件
 * @param downloadInfo 下载任务信息
 */
const downloadLyric = (downloadInfo: LX.Download.ListItem) => {
  if (!appSetting['download.isDownloadLrc']) return
  void getLyricInfo({
    musicInfo: downloadInfo.metadata.musicInfo,
    isRefresh: false,
    allowToggleSource: appSetting['download.isUseOtherSource'],
  }).then(lrcs => {
    if (lrcs.lyric) {
      lrcs.lyric = fixKgLyric(lrcs.lyric)
      let lyric = lrcs.lyric
      if (appSetting['download.isDownloadTLrc'] && lrcs.tlyric) lyric += '\n' + lrcs.tlyric + '\n'
      if (appSetting['download.isDownloadRLrc'] && lrcs.rlyric) lyric += '\n' + lrcs.rlyric + '\n'
      void window.lx.worker.download.saveLrc(downloadInfo.metadata.filePath.replace(/(mp3|flac|ape|wav)$/, 'lrc'),
        lyric, appSetting['download.lrcFormat'])
    }
  })
}

const getUrl = async(downloadInfo: LX.Download.ListItem, isRefresh: boolean = false) => {
  return getMusicUrl({
    musicInfo: downloadInfo.metadata.musicInfo,
    isRefresh: false,
    quality: downloadInfo.metadata.quality,
    allowToggleSource: appSetting['download.isUseOtherSource'],
  }).catch(() => '')
}
const handleRefreshUrl = (downloadInfo: LX.Download.ListItem) => {
  setStatusText(downloadInfo, window.i18n.t('download_status_error_refresh_url'))
  getMusicUrl({
    musicInfo: downloadInfo.metadata.musicInfo,
    isRefresh: true,
    quality: downloadInfo.metadata.quality,
    allowToggleSource: appSetting['download.isUseOtherSource'],
  })
    .then(url => {
      // commit('setStatusText', { downloadInfo, text: '链接刷新成功' })
      setUrl(downloadInfo, url)
      void window.lx.worker.download.updateUrl(downloadInfo.id, url)
    })
    .catch(err => {
      console.log(err)
      handleError(downloadInfo, err.message)
    })
}
const handleError = (downloadInfo: LX.Download.ListItem, message?: string) => {
  setStatus(downloadInfo, DOWNLOAD_STATUS.ERROR, message)
  void window.lx.worker.download.removeTask(downloadInfo.id)
  runingTask.delete(downloadInfo.id)
  void checkStartTask()
}

const handleStartTask = async(downloadInfo: LX.Download.ListItem) => {
  if (!downloadInfo.metadata.url) {
    setStatusText(downloadInfo, window.i18n.t('download_status_url_geting'))
    const url = await getUrl(downloadInfo)
    if (!url) {
      handleError(downloadInfo, window.i18n.t('download_status_error_url_failed'))
      return
    }
    setUrl(downloadInfo, url)
    if (downloadInfo.status != DOWNLOAD_STATUS.RUN) return
  }

  const filePath = joinPath(appSetting['download.savePath'], downloadInfo.metadata.fileName)
  if (downloadInfo.metadata.filePath != filePath) updateFilePath(downloadInfo, filePath)

  setStatusText(downloadInfo, window.i18n.t('download_status_start'))

  await window.lx.worker.download.startTask(toRaw(downloadInfo), appSetting['download.savePath'], appSetting['download.skipExistFile'], proxyCallback((event: LX.Download.DownloadTaskActions) => {
    // console.log(event)
    switch (event.action) {
      case 'start':
        setStatus(downloadInfo, DOWNLOAD_STATUS.RUN)
        break
      case 'complete':
        saveMeta(downloadInfo)
        downloadLyric(downloadInfo)
        void window.lx.worker.download.removeTask(downloadInfo.id)
        runingTask.delete(downloadInfo.id)
        setStatus(downloadInfo, DOWNLOAD_STATUS.COMPLETED)
        void checkStartTask()
        break
      case 'refreshUrl':
        handleRefreshUrl(downloadInfo)
        break
      case 'statusText':
        setStatusText(downloadInfo, event.data)
        break
      case 'progress':
        setProgress(downloadInfo, event.data)
        break
      case 'error':
        handleError(downloadInfo, event.data.error == null
          ? event.data.message ?? undefined
          // @ts-expect-error
          : window.i18n.t(event.data.error) + (event.data.message ?? ''))
        break
      default:
        break
    }
  }))
}
const startTask = async(downloadInfo: LX.Download.ListItem) => {
  setStatus(downloadInfo, DOWNLOAD_STATUS.RUN)
  runingTask.set(downloadInfo.id, downloadInfo)
  void handleStartTask(downloadInfo)
}

const getStartTask = (list: LX.Download.ListItem[]): LX.Download.ListItem | null => {
  let downloadCount = 0
  const waitList = list.filter(item => {
    if (item.status == DOWNLOAD_STATUS.WAITING) return true
    if (item.status == DOWNLOAD_STATUS.RUN) ++downloadCount
    return false
  })
  // console.log(downloadCount, waitList)
  return downloadCount < appSetting['download.maxDownloadNum'] ? waitList.shift() ?? null : null
}

const checkStartTask = async() => {
  if (runingTask.size >= appSetting['download.maxDownloadNum']) return
  let result = getStartTask(downloadList)
  // console.log(result)
  while (result) {
    await startTask(result)
    result = getStartTask(downloadList)
  }
}

/**
 * 过滤重复任务
 * @param list
 */
const filterTask = (list: LX.Download.ListItem[]) => {
  const set = new Set<string>()
  for (const item of downloadList) set.add(item.id)
  return list.filter(item => {
    if (set.has(item.id)) return false
    markRaw(item.metadata)
    set.add(item.id)
    return true
  })
}
/**
 * 创建下载任务
 * @param list 要下载的歌曲
 * @param quality 下载音质
 */
export const createDownloadTasks = async(list: LX.Music.MusicInfoOnline[], quality: LX.Quality) => {
  if (!list.length) return
  const tasks = filterTask(await window.lx.worker.download.createDownloadTasks(list, quality,
    appSetting['download.savePath'],
    appSetting['download.fileName'],
    toRaw(qualityList.value)),
  )

  if (tasks.length) await addTasks(tasks)
  void checkStartTask()
}

/**
 * 开始下载任务
 * @param list
 */
export const startDownloadTasks = async(list: LX.Download.ListItem[]) => {
  for (const downloadInfo of list) {
    switch (downloadInfo.status) {
      case DOWNLOAD_STATUS.PAUSE:
      case DOWNLOAD_STATUS.ERROR:
        if (runingTask.size < appSetting['download.maxDownloadNum']) void startTask(downloadInfo)
        else setStatus(downloadInfo, DOWNLOAD_STATUS.WAITING)
      default:
        break
    }
  }
  void checkStartTask()
}

/**
 * 暂停下载任务
 * @param list
 */
export const pauseDownloadTasks = async(list: LX.Download.ListItem[]) => {
  for (const downloadInfo of list) {
    switch (downloadInfo.status) {
      case DOWNLOAD_STATUS.RUN:
        void window.lx.worker.download.pauseTask(downloadInfo.id)
        runingTask.delete(downloadInfo.id)
      case DOWNLOAD_STATUS.WAITING:
      case DOWNLOAD_STATUS.ERROR:
        setStatus(downloadInfo, DOWNLOAD_STATUS.PAUSE)
      default:
        break
    }
  }
  void checkStartTask()
}

/**
 * 移除下载任务
 * @param ids 要移除的任务Id
 */
export const removeDownloadTasks = async(ids: string[]) => {
  await downloadTasksRemove(ids)

  const listSet = new Set<string>()
  for (const item of downloadList) listSet.add(item.id)
  for (const id of ids) listSet.delete(id)
  const newList = downloadList.filter(task => {
    if (runingTask.has(task.id)) {
      void window.lx.worker.download.removeTask(task.id)
      runingTask.delete(task.id)
    }
    return listSet.has(task.id)
  })
  downloadList.splice(0, downloadList.length)
  arrPush(downloadList, newList)


  void checkStartTask()
  window.app_event.downloadListUpdate()
}
