import React, { useEffect, useState, useRef, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';

// Ensure worker is set. 
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://esm.sh/pdfjs-dist@4.0.379/build/pdf.worker.min.mjs`;

interface PDFViewerProps {
  file: File;
  pageNumber: number;
  onLoadSuccess?: (numPages: number) => void;
}

export const PDFViewer: React.FC<PDFViewerProps> = ({ file, pageNumber, onLoadSuccess }) => {
  const [pdfDocument, setPdfDocument] = useState<any>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<any>(null);

  // Load PDF Document
  useEffect(() => {
    const loadPdf = async () => {
      try {
          const arrayBuffer = await file.arrayBuffer();
          const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
          const pdf = await loadingTask.promise;
          setPdfDocument(pdf);
          if (onLoadSuccess) onLoadSuccess(pdf.numPages);
      } catch (e) {
          console.error("Error loading PDF for viewer", e);
      }
    };
    loadPdf();
  }, [file, onLoadSuccess]);

  const renderPage = useCallback(async () => {
      if (!pdfDocument || !canvasRef.current || !containerRef.current) return;
      
      // Cancel any pending render task to avoid race conditions
      if (renderTaskRef.current) {
          try {
              renderTaskRef.current.cancel();
          } catch (e) {
              // Ignore cancel error
          }
      }

      try {
        const page = await pdfDocument.getPage(pageNumber);
        const container = containerRef.current;
        const canvas = canvasRef.current;
        const context = canvas.getContext('2d');
        if (!context) return;

        // Calculate scale to fit container (contain)
        // We use the viewport at scale 1 to determine aspect ratio
        const viewportRaw = page.getViewport({ scale: 1 });
        const availableWidth = container.clientWidth;
        const availableHeight = container.clientHeight;
        
        if (availableWidth === 0 || availableHeight === 0) return;

        const scaleW = (availableWidth - 32) / viewportRaw.width; // 32px padding
        const scaleH = (availableHeight - 32) / viewportRaw.height;
        // Use the smaller scale to fit entire slide
        const scale = Math.min(scaleW, scaleH);

        const viewport = page.getViewport({ scale });

        canvas.width = viewport.width;
        canvas.height = viewport.height;

        const renderContext = {
          canvasContext: context,
          viewport: viewport,
        };
        
        const renderTask = page.render(renderContext);
        renderTaskRef.current = renderTask;
        
        await renderTask.promise;
      } catch (e: any) {
          if (e?.name !== 'RenderingCancelledException') {
              console.error("Render error", e);
          }
      }
  }, [pdfDocument, pageNumber]);

  useEffect(() => {
      renderPage();
      const handleResize = () => renderPage();
      window.addEventListener('resize', handleResize);
      return () => window.removeEventListener('resize', handleResize);
  }, [renderPage]);

  return (
    <div ref={containerRef} className="w-full h-full flex items-center justify-center bg-gray-900 overflow-hidden relative select-none">
        {!pdfDocument && <div className="text-gray-500 animate-pulse">Loading Slides...</div>}
        <canvas ref={canvasRef} className="shadow-2xl rounded-sm bg-white" />
    </div>
  )
}