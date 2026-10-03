import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from "@/components/ui/form";
import {
  useRequestRecruitmentUpload,
  useSubmitRecruitmentApplication,
  RecruitmentUploadInputContentType,
  RecruitmentApplicationInputCvContentType
} from "@workspace/api-client-react";
import { AlertCircle, CheckCircle2, Loader2, UploadCloud } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";

const formSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters."),
  email: z.string().email("Please enter a valid email address."),
  details: z.string().min(20, "Please provide more detail about your experience and interests."),
  consent: z.boolean().refine(val => val === true, "You must agree to the privacy policy."),
  website: z.string().max(0, "Invalid submission").optional(), // honeypot
  cv: z.any()
    .refine((files) => files && files.length === 1, "A CV file is required.")
    .refine((files) => files && files[0]?.size <= 5 * 1024 * 1024, "Max file size is 5MB.")
    .refine(
      (files) => files && ["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"].includes(files[0]?.type),
      "Only .pdf, .doc, and .docx formats are supported."
    )
});

type FormValues = z.infer<typeof formSchema>;

export function JoinMissionForm() {
  const [status, setStatus] = useState<"idle" | "uploading" | "submitting" | "success" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState("");

  const { toast } = useToast();

  const requestUpload = useRequestRecruitmentUpload();
  const submitApplication = useSubmitRecruitmentApplication();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      email: "",
      details: "",
      website: "",
      consent: false,
    }
  });

  const onSubmit = async (data: FormValues) => {
    setStatus("uploading");
    setErrorMessage("");

    try {
      const file = data.cv[0] as File;

      const uploadReqData = {
        name: file.name,
        size: file.size,
        contentType: file.type as RecruitmentUploadInputContentType,
      };

      const uploadRes = await requestUpload.mutateAsync({ data: uploadReqData });

      if (!uploadRes.uploadUrl || !uploadRes.objectPath) {
        throw new Error("Failed to get upload credentials from server.");
      }

      // Upload file directly to object storage
      const uploadResponse = await fetch(uploadRes.uploadUrl, {
        method: "PUT",
        body: file,
        headers: {
          "Content-Type": file.type,
        }
      });

      if (!uploadResponse.ok) {
        throw new Error("Storage failure: Could not upload CV file. Please try again.");
      }

      setStatus("submitting");

      const submitData = {
        name: data.name,
        email: data.email,
        details: data.details,
        consent: data.consent,
        website: data.website || "",
        cvObjectPath: uploadRes.objectPath,
        cvFileName: file.name,
        cvContentType: file.type as RecruitmentApplicationInputCvContentType,
        cvSize: file.size,
      };

      const submitRes = await submitApplication.mutateAsync({ data: submitData });

      if (submitRes.status === "received") {
        setStatus("success");
        form.reset();
      } else {
         throw new Error("Application submission failed.");
      }

    } catch (err: unknown) {
      setStatus("error");
      const apiError = err as { status?: number; data?: { error?: string }; message?: string };
      let message = "An unexpected error occurred. Please try again later.";
      if (apiError.status === 409) {
        message = "An application with this email has already been submitted.";
      } else if (apiError.status === 400) {
        message = apiError.data?.error || "Invalid file or submission data.";
      } else if (apiError.data?.error) {
        message = apiError.data.error;
      } else if (apiError.message) {
        message = apiError.message;
      }

      setErrorMessage(message);
      toast({
        variant: "destructive",
        title: "Submission Failed",
        description: message
      });
    }
  };

  if (status === "success") {
    return (
      <div className="flex flex-col items-center justify-center text-center space-y-5 py-16 animate-in fade-in zoom-in duration-500">
        <div className="w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center relative">
          <div className="absolute inset-0 rounded-full animate-ping bg-primary/20 opacity-75" />
          <CheckCircle2 className="w-8 h-8 text-primary relative z-10" />
        </div>
        <div className="space-y-2">
          <h3 className="text-2xl font-serif font-bold text-foreground">Application Received</h3>
          <p className="text-muted-foreground max-w-sm mx-auto">
            Thank you for your interest in Landa Travels. Your details and CV are securely stored for private review.
          </p>
        </div>
        <Button variant="outline" onClick={() => setStatus("idle")} className="mt-6">
          Submit Another
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div aria-live="polite" className="sr-only">
        {status === "uploading" && "Uploading your CV..."}
        {status === "submitting" && "Submitting your application..."}
        {status === "error" && `Error: ${errorMessage}`}
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">

          <div className="grid md:grid-cols-2 gap-5">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Full Name</FormLabel>
                  <FormControl>
                    <Input placeholder="Jane Doe" {...field} disabled={status === "uploading" || status === "submitting"} className="bg-background" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email Address</FormLabel>
                  <FormControl>
                    <Input type="email" placeholder="jane@example.com" {...field} disabled={status === "uploading" || status === "submitting"} className="bg-background" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="details"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Experience & Interests</FormLabel>
                <FormControl>
                  <Textarea
                    placeholder="Tell us about your background and why you want to join..."
                    className="min-h-[140px] resize-y bg-background"
                    {...field}
                    disabled={status === "uploading" || status === "submitting"}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="cv"
            render={({ field: { value, onChange, ...fieldProps } }) => (
              <FormItem>
                <FormLabel>Curriculum Vitae</FormLabel>
                <FormDescription>PDF, DOC, or DOCX format (Max 5MB)</FormDescription>
                <FormControl>
                  <div className="pt-2">
                    <Input
                      type="file"
                      accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                      onChange={(e) => onChange(e.target.files)}
                      disabled={status === "uploading" || status === "submitting"}
                      className="cursor-pointer file:cursor-pointer file:text-primary file:font-medium file:bg-primary/10 file:border-0 file:rounded-md file:px-4 file:py-1 file:mr-4 hover:file:bg-primary/20 text-muted-foreground bg-background"
                      {...fieldProps}
                    />
                  </div>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Honeypot field for anti-spam */}
          <div className="hidden" aria-hidden="true">
            <FormField
              control={form.control}
              name="website"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Website</FormLabel>
                  <FormControl>
                    <Input tabIndex={-1} autoComplete="off" {...field} />
                  </FormControl>
                </FormItem>
              )}
            />
          </div>

          <FormField
            control={form.control}
            name="consent"
            render={({ field }) => (
              <FormItem className="flex flex-row items-start space-x-3 space-y-0 p-4 border border-border/60 rounded-lg bg-card/30">
                <FormControl>
                  <Checkbox
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    disabled={status === "uploading" || status === "submitting"}
                    className="mt-1"
                  />
                </FormControl>
                <div className="space-y-1.5 leading-none">
                  <FormLabel className="cursor-pointer font-normal text-sm leading-relaxed">
                    I consent to the processing of my personal data for recruitment purposes.
                  </FormLabel>
                  <FormDescription>
                    Read our <Link href="/privacy#recruitment-applications" className="text-primary hover:underline underline-offset-4">privacy policy</Link> for more information.
                  </FormDescription>
                </div>
              </FormItem>
            )}
          />

          {status === "error" && (
            <div className="p-4 rounded-lg bg-destructive/10 text-destructive-foreground border border-destructive/20 flex items-center gap-3 animate-in slide-in-from-top-2">
              <AlertCircle className="w-5 h-5 shrink-0 text-destructive" />
              <p className="text-sm font-medium">{errorMessage}</p>
            </div>
          )}

          <Button
            type="submit"
            size="lg"
            className="w-full relative overflow-hidden transition-all duration-300 group"
            disabled={status === "uploading" || status === "submitting"}
          >
            <span className="absolute inset-0 bg-primary-foreground/10 translate-y-full group-hover:translate-y-0 transition-transform duration-300" />
            <span className="relative z-10 flex items-center gap-2 font-semibold">
              {status === "uploading" && <><Loader2 className="w-5 h-5 animate-spin" /> Uploading CV...</>}
              {status === "submitting" && <><Loader2 className="w-5 h-5 animate-spin" /> Submitting Application...</>}
              {status === "idle" && <><UploadCloud className="w-5 h-5" /> Submit Application</>}
              {status === "error" && <><UploadCloud className="w-5 h-5" /> Try Again</>}
            </span>
          </Button>
        </form>
      </Form>
    </div>
  );
}
