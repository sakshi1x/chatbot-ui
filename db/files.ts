import { supabase } from "@/lib/supabase/browser-client"
import { TablesInsert, TablesUpdate } from "@/supabase/types"
import mammoth from "mammoth"
import { toast } from "sonner"
import { uploadFile } from "./storage/files"
import { PrivategptApiClient } from "privategpt-sdk-web"

export const getFileById = async (fileId: string) => {
  const { data: file, error } = await supabase
    .from("files")
    .select("*")
    .eq("id", fileId)
    .single()

  if (!file) {
    throw new Error(error.message)
  }

  return file
}

export const getFileWorkspacesByWorkspaceId = async (workspaceId: string) => {
  const { data: workspace, error } = await supabase
    .from("workspaces")
    .select(
      `
      id,
      name,
      files (*)
    `
    )
    .eq("id", workspaceId)
    .single()

  if (!workspace) {
    throw new Error(error.message)
  }

  return workspace
}

export const getFileWorkspacesByFileId = async (fileId: string) => {
  const { data: file, error } = await supabase
    .from("files")
    .select(
      `
      id, 
      name, 
      workspaces (*)
    `
    )
    .eq("id", fileId)
    .single()

  if (!file) {
    throw new Error(error.message)
  }

  return file
}

export const createFileBasedOnExtension = async (
  file: File,
  fileRecord: TablesInsert<"files">,
  workspace_id: string,
  embeddingsProvider: "openai" | "local"
) => {
  const fileExtension = file.name.split(".").pop()

  if (fileExtension === "docx") {
    const arrayBuffer = await file.arrayBuffer()
    const result = await mammoth.extractRawText({
      arrayBuffer
    })

    return createDocXFile(
      result.value,
      file,
      fileRecord,
      workspace_id,
      embeddingsProvider
    )
  } else {
    return createFile(file, fileRecord, workspace_id, embeddingsProvider)
  }
}

// For non-docx files
export const createFile = async (
  file: File,
  fileRecord: TablesInsert<"files">,
  workspace_id: string,
  embeddingsProvider: "openai" | "local"
) => {
  let validFilename = fileRecord.name.replace(/[^a-z0-9.]/gi, "_").toLowerCase()
  const extension = file.name.split(".").pop()
  const baseName = validFilename.substring(0, validFilename.lastIndexOf("."))
  const maxBaseNameLength = 100 - (extension?.length || 0) - 1
  if (baseName.length > maxBaseNameLength) {
    fileRecord.name = baseName.substring(0, maxBaseNameLength) + "." + extension
  } else {
    fileRecord.name = baseName + "." + extension
  }
  const { data: createdFile, error } = await supabase
    .from("files")
    .insert([fileRecord])
    .select("*")
    .single()

  console.log("createdFile", createdFile)

  if (error) {
    throw new Error(error.message)
  }

  await createFileWorkspace({
    user_id: createdFile.user_id,
    file_id: createdFile.id,
    workspace_id
  })

  // todo: use one instance in all app
  const instance = new PrivategptApiClient({
    environment: "http://localhost:8001"
  })
  const r = await instance.ingestion.ingestFile(file)
  console.log(r)

  const filePath = await uploadFile(file, {
    name: createdFile.name,
    user_id: createdFile.user_id,
    file_id: createdFile.name
  })

  await updateFile(createdFile.id, {
    file_path: filePath
  })

  const formData = new FormData()
  formData.append("file_id", createdFile.id)
  formData.append("embeddingsProvider", embeddingsProvider)

  const response = await fetch("/api/retrieval/process", {
    method: "POST",
    body: formData
  })

  if (!response.ok) {
    const jsonText = await response.text()
    const json = JSON.parse(jsonText)
    console.error(
      `Error processing file:${createdFile.id}, status:${response.status}, response:${json.message}`
    )
    toast.error("Failed to process file. Reason:" + json.message, {
      duration: 10000
    })
    await deleteFile(createdFile.id)
  }

  const fetchedFile = await getFileById(createdFile.id)

  console.log("fetchedFile", fetchedFile)

  return fetchedFile
}

// // Handle docx files
export const createDocXFile = async (
  text: string,
  file: File,
  fileRecord: TablesInsert<"files">,
  workspace_id: string,
  embeddingsProvider: "openai" | "local"
) => {
  const { data: createdFile, error } = await supabase
    .from("files")
    .insert([fileRecord])
    .select("*")
    .single()

  if (error) {
    throw new Error(error.message)
  }

  await createFileWorkspace({
    user_id: createdFile.user_id,
    file_id: createdFile.id,
    workspace_id
  })

  const filePath = await uploadFile(file, {
    name: createdFile.name,
    user_id: createdFile.user_id,
    file_id: createdFile.name
  })

  await updateFile(createdFile.id, {
    file_path: filePath
  })

  const response = await fetch("/api/retrieval/process/docx", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text: text,
      fileId: createdFile.id,
      embeddingsProvider,
      fileExtension: "docx"
    })
  })

  if (!response.ok) {
    const jsonText = await response.text()
    const json = JSON.parse(jsonText)
    console.error(
      `Error processing file:${createdFile.id}, status:${response.status}, response:${json.message}`
    )
    toast.error("Failed to process file. Reason:" + json.message, {
      duration: 10000
    })
    await deleteFile(createdFile.id)
  }

  const fetchedFile = await getFileById(createdFile.id)

  return fetchedFile
}

export const createFiles = async (
  files: TablesInsert<"files">[],
  workspace_id: string
) => {
  const { data: createdFiles, error } = await supabase
    .from("files")
    .insert(files)
    .select("*")

  if (error) {
    throw new Error(error.message)
  }

  await createFileWorkspaces(
    createdFiles.map(file => ({
      user_id: file.user_id,
      file_id: file.id,
      workspace_id
    }))
  )

  return createdFiles
}

export const createFileWorkspace = async (item: {
  user_id: string
  file_id: string
  workspace_id: string
}) => {
  const { data: createdFileWorkspace, error } = await supabase
    .from("file_workspaces")
    .insert([item])
    .select("*")
    .single()

  if (error) {
    throw new Error(error.message)
  }

  return createdFileWorkspace
}

export const createFileWorkspaces = async (
  items: { user_id: string; file_id: string; workspace_id: string }[]
) => {
  const { data: createdFileWorkspaces, error } = await supabase
    .from("file_workspaces")
    .insert(items)
    .select("*")

  if (error) throw new Error(error.message)

  return createdFileWorkspaces
}

export const updateFile = async (
  fileId: string,
  file: TablesUpdate<"files">
) => {
  const { data: updatedFile, error } = await supabase
    .from("files")
    .update(file)
    .eq("id", fileId)
    .select("*")
    .single()

  if (error) {
    throw new Error(error.message)
  }

  return updatedFile
}

// const sampleInjested = {
//   "object": "list",
//   "model": "private-gpt",
//   "data": [
//     {
//       "object": "ingest.document",
//       "doc_id": "733a0bc2-dc6a-41b8-8a8b-85f380164692",
//       "doc_metadata": {
//         "page_label": "1",
//         "file_name": "Project .pdf"
//       }
//     },
//     {
//       "object": "ingest.document",
//       "doc_id": "60a53de5-5821-40cd-bb44-e4e5803b086a",
//       "doc_metadata": {
//         "page_label": "2",
//         "file_name": "Project .pdf"
//       }
//     },
//     {
//       "object": "ingest.document",
//       "doc_id": "3cfe52de-5d37-450c-ac91-779b983287c6",
//       "doc_metadata": {
//         "page_label": "3",
//         "file_name": "Project .pdf"
//       }
//     },
//     {
//       "object": "ingest.document",
//       "doc_id": "627d5143-cb72-4f49-bef1-483ba767f33e",
//       "doc_metadata": {
//         "page_label": "4",
//         "file_name": "Project .pdf"
//       }
//     },
//     {
//       "object": "ingest.document",
//       "doc_id": "0e0df119-de62-4c6a-9490-699b4adff21c",
//       "doc_metadata": {
//         "page_label": "5",
//         "file_name": "Project .pdf"
//       }
//     },
//     {
//       "object": "ingest.document",
//       "doc_id": "fd265b0e-27af-42a3-9167-8bd7e32411e4",
//       "doc_metadata": {
//         "page_label": "6",
//         "file_name": "Project .pdf"
//       }
//     },
//     {
//       "object": "ingest.document",
//       "doc_id": "17cb9c85-7b63-47d2-9a99-68d9ff53bc23",
//       "doc_metadata": {
//         "page_label": "7",
//         "file_name": "Project .pdf"
//       }
//     }
//   ]
// }

export const deleteFile = async (fileId: string) => {
  const { error, ...rest } = await supabase.from("files").delete().eq("id", fileId)
  // console.log(rest)

  // todo: use one instance in all app
  const pgptInstance = new PrivategptApiClient({
    environment: "http://localhost:8001"
  })

  // const file = await supabase.from('files').select('*').eq('id', fileId)
  // const injestedPgptFiles = await pgptInstance.ingestion.listIngested()
  // const deleteInjested = sampleInjested.data.map(async d =>
  //   await pgptInstance.ingestion.deleteIngested(d.doc_id)

  // )
  // Promise.all(deleteInjested)
  // const fileToDelete = injestedPgptFiles.data


  // console.log(file.data, injestedPgptFiles)


  await pgptInstance.ingestion.deleteIngested(fileId)

  if (error) {
    throw new Error(error.message)
  }

  return true
}

export const deleteFileWorkspace = async (
  fileId: string,
  workspaceId: string
) => {
  const { error } = await supabase
    .from("file_workspaces")
    .delete()
    .eq("file_id", fileId)
    .eq("workspace_id", workspaceId)

  const file = await supabase.from('files').select('id').eq('id', fileId)
  console.log(file)

  // todo: use one instance in all app
  const pgptInstance = new PrivategptApiClient({
    environment: "http://localhost:8001"
  })

  await pgptInstance.ingestion.deleteIngested(fileId)

  if (error) throw new Error(error.message)

  return true
}
