import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useSubmitContactRequest } from "@workspace/api-client-react";
import { Send, CheckCircle2, MessageSquare, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent } from "@/components/ui/card";
import { useState } from "react";
import { Link } from "wouter";

const formSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(100),
  email: z.string().email("Invalid email address"),
  topic: z.string().max(80).optional(),
  message: z.string().min(10, "Message must be at least 10 characters").max(2000),
  consent: z.literal(true, {
    errorMap: () => ({ message: "You must agree to our privacy policy" }),
  }),
});

export default function Contact() {
  const [isSuccess, setIsSuccess] = useState(false);
  const submitContact = useSubmitContactRequest();

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      email: "",
      topic: "",
      message: "",
    },
  });

  function onSubmit(values: z.infer<typeof formSchema>) {
    submitContact.mutate({ data: values }, {
      onSuccess: () => {
        setIsSuccess(true);
        form.reset();
      }
    });
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-4 md:p-8 animate-fade-in-up py-16">
      <div className="max-w-xl w-full text-center mb-10">
        <div className="w-16 h-16 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-primary mx-auto mb-6 shadow-inner">
          <MessageSquare size={28} />
        </div>
        <h1 className="text-4xl font-serif font-bold mb-4">Get in Touch</h1>
        <p className="text-lg text-muted-foreground">
          Have a question about our methodology, need press information, or want to partner with us? Our team is ready.
        </p>
      </div>

      <Card className="w-full max-w-xl bg-card border-border/50 shadow-2xl backdrop-blur-sm">
        <CardContent className="p-6 md:p-8">
          {isSuccess ? (
            <div className="flex flex-col items-center justify-center text-center py-12 space-y-4 animate-fade-in-up">
              <CheckCircle2 size={64} className="text-primary mb-2" />
              <h2 className="text-2xl font-serif font-bold">Message Received</h2>
              <p className="text-muted-foreground">
                Thank you for reaching out. A member of our team will respond to your inquiry shortly.
              </p>
              <Button variant="outline" className="mt-6 rounded-full" onClick={() => setIsSuccess(false)}>
                Send another message
              </Button>
            </div>
          ) : (
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                <div className="grid md:grid-cols-2 gap-6">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="font-bold">Full Name</FormLabel>
                        <FormControl>
                          <Input placeholder="Jane Doe" className="bg-background/50 h-12" {...field} />
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
                        <FormLabel className="font-bold">Email Address</FormLabel>
                        <FormControl>
                          <Input type="email" placeholder="jane@example.com" className="bg-background/50 h-12" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                
                <FormField
                  control={form.control}
                  name="topic"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-bold">Topic (Optional)</FormLabel>
                      <FormControl>
                        <Input placeholder="Partnership, Support, Press..." className="bg-background/50 h-12" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="message"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel className="font-bold">Message</FormLabel>
                      <FormControl>
                        <Textarea 
                          placeholder="How can we help you?" 
                          className="min-h-[120px] resize-y bg-background/50" 
                          {...field} 
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="consent"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-start space-x-3 space-y-0 p-4 rounded-xl border border-border/50 bg-background/30">
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={field.onChange}
                          className="mt-1"
                        />
                      </FormControl>
                      <div className="space-y-1 leading-none">
                        <FormLabel className="text-sm font-medium leading-relaxed">
                          I consent to Landa Travels processing my data to handle this inquiry, as detailed in our <Link href="/privacy#contact-and-communications" className="text-primary hover:text-primary/80 underline underline-offset-4 transition-colors">Privacy Policy</Link>.
                        </FormLabel>
                        <FormDescription className="text-xs">
                          Your data is never sold or used for marketing without explicit permission.
                        </FormDescription>
                      </div>
                    </FormItem>
                  )}
                />

                <Button type="submit" className="w-full h-14 rounded-xl text-base font-bold shadow-lg" disabled={submitContact.isPending}>
                  {submitContact.isPending ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : <Send className="mr-2 h-5 w-5" />}
                  Send Message
                </Button>
              </form>
            </Form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
