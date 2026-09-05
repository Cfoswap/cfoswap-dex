function Loading() {
  return (
    <div className="flex items-center justify-center py-20">
      <div className="flex flex-col items-center gap-3">
        <div className="w-10 h-10 border-4 border-primary-200 border-t-primary-600 rounded-full animate-spin"></div>
        <span className="text-sm text-gray-500">加载中...</span>
      </div>
    </div>
  )
}

export default Loading
